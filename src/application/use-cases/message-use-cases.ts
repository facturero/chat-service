import { canBroadcast, canDelete, canEdit, canRead, canWrite } from '../../domain/access.js';
import {
  ConversationArchivedError,
  ConversationNotFoundError,
  ForbiddenError,
  MessageNotFoundError,
  RateLimitedError,
  UserInactiveError,
  ValidationError,
} from '../../domain/errors.js';
import { computeRecipients } from '../../domain/recipients.js';
import { parseRichText, RichTextError } from '../../domain/richtext.js';
import { customReactionName } from '../../domain/emojis.js';
import { booleanQuery, decodeCursor, encodeCursor, searchTerms, shortTerms, snippet } from '../../domain/search.js';
import type { ReactionGroup, Repositories } from '../../domain/repositories.js';
import type { Actor, Conversation, Member, Message } from '../../domain/types.js';
import { memberJoinedEvent, messageCreatedEvent, messageDeletedEvent, messageUpdatedEvent, reactionEvent } from '../events.js';
import { inTransaction, type Clock, type IdGenerator, type UnitOfWorkGateway } from '../ports.js';

export interface SendMessageInput {
  clientMsgId: string;
  bodyDoc: unknown;
  threadRootId?: string | null;
}

export interface SearchInput {
  q: string;
  conversationId?: string;
  fromUserId?: string;
  cursor?: string;
  limit: number;
}

export interface SearchHit {
  message: Message;
  conversation: Conversation;
  snippet: string;
}

/** Un hilo en la vista «Hilos»: la raíz, sus últimas respuestas y lo que me falta leer. */
export interface ThreadItem {
  root: Message;
  conversation: Conversation;
  latestReplies: Message[];
  lastReadThreadSeq: number;
  unreadCount: number;
  mentionCount: number;
}

export interface MessagePage {
  items: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
  lastReadSeq: number | null;
}

/** Límite de envío por persona (30 por minuto). En memoria: el servicio corre en una réplica (IMPLEMENTATION.md). */
export class SendRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = 30, private readonly windowMs = 60_000, private readonly clock: Clock = () => new Date()) {}

  take(userId: string): boolean {
    const now = this.clock().getTime();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return true;
  }
}

/** Un emoji de reacción: el carácter (o la secuencia) tal cual, sin letras ni espacios sueltos, y corto; o uno personalizado, `:nombre:`. */
const EMOJI = /^[^\s\p{L}\p{N}]{1,16}$/u;

/** Mensajes: enviar y leer (entregable 1); hilos, reacciones, editar y borrar (entregable 2). */
export class MessageUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly limiter: SendRateLimiter,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Enviar. El `seq` se decide con la fila de la conversación bloqueada (`FOR UPDATE`): 30 envíos a la vez salen 1..30 sin huecos ni
   * repetidos. Idempotente por `clientMsgId`: el mismo envío dos veces (red lenta, reintento) devuelve el mensaje ya guardado — el
   * segundo espera el bloqueo y lo encuentra. Escribir en un canal público sin ser miembro une primero (como Slack).
   */
  async send(actor: Actor, conversationId: string, input: SendMessageInput): Promise<{ message: Message; existed: boolean }> {
    let parsed;
    try {
      parsed = parseRichText(input.bodyDoc);
    } catch (err) {
      if (err instanceof RichTextError) throw new ValidationError([{ field: 'bodyDoc', message: err.message }]);
      throw err;
    }
    if (parsed.isEmpty) throw new ValidationError([{ field: 'bodyDoc', message: 'El mensaje está vacío.' }]);

    // El reintento del mismo envío no gasta cupo: se mira antes de contar.
    const already = await this.repos.messages.findByClientMsgId(conversationId, input.clientMsgId);
    if (already && already.organizationId === actor.organizationId && already.senderId === actor.userId) return { message: already, existed: true };
    if (!this.limiter.take(actor.userId)) throw new RateLimitedError();

    return inTransaction(this.gateway, async (uow) => {
      const c = await uow.conversations.findByIdForUpdate(actor.organizationId, conversationId);
      if (!c) throw new ConversationNotFoundError();
      let me = await uow.members.find(c.id, actor.userId);
      if (!canRead(c, me)) throw new ConversationNotFoundError();
      if (c.archivedAt) throw new ConversationArchivedError();

      const existing = await uow.messages.findByClientMsgId(c.id, input.clientMsgId);
      if (existing) {
        if (existing.senderId !== actor.userId) throw new ValidationError([{ field: 'clientMsgId', message: 'Ese identificador ya se usó.' }]);
        return { message: existing, existed: true };
      }

      if (!me) {
        me = this.newMember(c, actor.userId);
        await uow.members.insertIfAbsent(me);
        await uow.outbox.add(memberJoinedEvent(c, [actor.userId], (await uow.members.list(c.id)).map((m) => m.userId), 'joined'));
      }

      const members = await uow.members.list(c.id);
      if (c.kind !== 'channel') await this.assertDmWritable(uow, c, members, actor);

      const memberIds = new Set(members.map((m) => m.userId));
      const mentioned = parsed.mentions.filter((u) => memberIds.has(u) && u !== actor.userId);
      if ((parsed.mentionsChannel || parsed.mentionsHere) && !canBroadcast(actor, c, me, members.length)) {
        throw new ForbiddenError('En un canal tan grande, @canal y @aquí solo los puede usar quien administra el canal.');
      }

      const now = this.clock();
      // Respuesta de hilo: su número sale de la raíz bloqueada (como el `seq` de la conversación). No mueve el `seq` del canal ni su
      // «último mensaje»: un hilo no deja el canal sin leer (como Slack).
      let root: Message | null = null;
      if (input.threadRootId) {
        root = await uow.messages.findByIdForUpdate(c.organizationId, input.threadRootId);
        if (!root || root.conversationId !== c.id || root.threadRootId !== null || root.seq === null) {
          throw new ValidationError([{ field: 'threadRootId', message: 'Ese mensaje no admite respuestas aquí.' }]);
        }
      } else {
        c.messageSeq += 1;
        c.lastMessageAt = now;
        c.updatedAt = now;
        await uow.conversations.update(c);
      }

      const message: Message = {
        id: this.ids(),
        organizationId: c.organizationId,
        conversationId: c.id,
        seq: root ? null : c.messageSeq,
        threadRootId: root?.id ?? null,
        threadSeq: root ? root.replyCount + 1 : null,
        senderId: actor.userId,
        kind: 'user',
        bodyDoc: parsed.doc,
        bodyText: parsed.text,
        clientMsgId: input.clientMsgId,
        replyCount: 0,
        lastReplyAt: null,
        replyUserIds: [],
        editedAt: null,
        deletedAt: null,
        deletedBy: null,
        createdAt: now,
      };
      // Con la conversación bloqueada no puede chocar; si chocara (un UNIQUE que no se esperaba), mejor fallar que perder el mensaje.
      if (!(await uow.messages.insertIfAbsent(message))) throw new Error(`no se pudo guardar el mensaje seq=${message.seq}`);

      let followers: string[] | undefined;
      if (root) {
        // Siguen el hilo: el autor de la raíz, quien responde y quien es mencionado. Los avisos van a los que ya lo seguían.
        followers = await uow.threadFollowers.list(root.id);
        await uow.threadFollowers.add(root.id, [root.senderId ?? actor.userId, actor.userId, ...mentioned], c.organizationId);
        if (!followers.length && root.senderId) followers = [root.senderId];
        root.replyCount += 1;
        root.lastReplyAt = now;
        root.replyUserIds = [actor.userId, ...root.replyUserIds.filter((u) => u !== actor.userId)].slice(0, 3);
        await uow.messages.update(root);
        // Quien responde ya leyó el hilo hasta su respuesta (como al escribir en el canal): no le queda como «nuevo».
        await uow.threadFollowers.markRead(root.id, actor.userId, message.threadSeq!);
      }

      const recipients = computeRecipients({
        conversation: c,
        members,
        senderId: actor.userId,
        mentionedUserIds: mentioned,
        mentionsChannel: parsed.mentionsChannel && c.kind === 'channel',
        mentionsHere: parsed.mentionsHere && c.kind === 'channel',
        ...(followers ? { threadFollowerIds: followers } : {}),
      });
      if (recipients.mentions.length) {
        await uow.mentions.insertMany(recipients.mentions.map((m) => ({ messageId: message.id, userId: m.userId, organizationId: c.organizationId, conversationId: c.id, kind: m.kind })));
      }
      // Lo que uno escribe en el canal, ya lo leyó: su cursor avanza con el mensaje (una respuesta de hilo no lo mueve).
      if (message.seq !== null) await uow.members.advanceRead(c.id, actor.userId, message.seq);
      await uow.outbox.add(messageCreatedEvent(c, message, recipients, mentioned));
      return { message, existed: false };
    });
  }

  async list(actor: Actor, conversationId: string, q: { before?: number; after?: number; around?: string; limit: number }): Promise<MessagePage> {
    const c = await this.repos.conversations.findById(actor.organizationId, conversationId);
    if (!c) throw new ConversationNotFoundError();
    const me = await this.repos.members.find(c.id, actor.userId);
    if (!canRead(c, me)) throw new ConversationNotFoundError();

    let items: Message[];
    if (q.around) {
      const target = await this.repos.messages.findById(actor.organizationId, q.around);
      if (!target || target.conversationId !== c.id || target.seq === null) throw new MessageNotFoundError();
      const half = Math.max(1, Math.floor(q.limit / 2));
      const older = await this.repos.messages.listRoots(c.id, { before: target.seq + 1, limit: half + 1 });
      const newer = await this.repos.messages.listRoots(c.id, { after: target.seq, limit: half });
      items = [...older, ...newer];
    } else {
      items = await this.repos.messages.listRoots(c.id, { before: q.before, after: q.after, limit: q.limit });
    }
    const first = items[0]?.seq ?? null;
    const last = items[items.length - 1]?.seq ?? null;
    return {
      items,
      hasOlder: first !== null && (await this.repos.messages.hasRootBefore(c.id, first)),
      hasNewer: last !== null && (await this.repos.messages.hasRootAfter(c.id, last)),
      lastReadSeq: me ? me.lastReadSeq : null,
    };
  }

  async get(actor: Actor, messageId: string): Promise<Message> {
    const m = await this.repos.messages.findById(actor.organizationId, messageId);
    if (!m) throw new MessageNotFoundError();
    const c = await this.repos.conversations.findById(actor.organizationId, m.conversationId);
    if (!c || !canRead(c, await this.repos.members.find(c.id, actor.userId))) throw new MessageNotFoundError();
    return m;
  }

  /** Respuestas de un hilo (y su raíz), ascendentes. */
  async replies(actor: Actor, rootId: string, q: { after?: number; limit: number }): Promise<{ root: Message; items: Message[]; hasMore: boolean }> {
    const root = await this.get(actor, rootId);
    if (root.threadRootId !== null) throw new MessageNotFoundError();
    const items = await this.repos.messages.listReplies(root.id, { after: q.after, limit: q.limit + 1 });
    return { root, items: items.slice(0, q.limit), hasMore: items.length > q.limit };
  }

  /**
   * Vista «Hilos» (como la de Slack): los hilos que sigo (escribí la raíz, respondí o me mencionaron), el de respuesta más reciente
   * primero, con sus dos últimas respuestas y cuántas me faltan leer. Solo los que todavía puedo leer.
   */
  async threads(actor: Actor, q: { cursor?: string; limit: number }): Promise<{ items: ThreadItem[]; nextCursor: string | null }> {
    const before = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !before) throw new ValidationError([{ field: 'cursor', message: 'Cursor inválido.' }]);
    const found = await this.repos.threadFollowers.listForUser({
      organizationId: actor.organizationId,
      userId: actor.userId,
      before: before ? { lastReplyAt: before.createdAt, id: before.id } : undefined,
      limit: q.limit + 1,
    });
    const page = found.slice(0, q.limit);
    const counts = await this.repos.threadFollowers.counts(actor.userId, page.map((x) => ({ threadRootId: x.root.id, lastReadThreadSeq: x.lastReadThreadSeq })));
    const conversations = new Map<string, Conversation>();
    for (const id of new Set(page.map((x) => x.root.conversationId))) {
      const c = await this.repos.conversations.findById(actor.organizationId, id);
      if (c) conversations.set(id, c);
    }
    const items: ThreadItem[] = [];
    for (const x of page) {
      const conversation = conversations.get(x.root.conversationId);
      if (!conversation) continue;
      const k = counts.get(x.root.id);
      items.push({
        root: x.root,
        conversation,
        latestReplies: await this.repos.messages.latestReplies(x.root.id, 2),
        lastReadThreadSeq: x.lastReadThreadSeq,
        unreadCount: k?.unread ?? 0,
        mentionCount: k?.mentions ?? 0,
      });
    }
    const last = page[page.length - 1]?.root;
    return { items, nextCursor: found.length > q.limit && last?.lastReplyAt ? encodeCursor(last.lastReplyAt, last.id) : null };
  }

  /** Leí el hilo hasta esta respuesta (lo manda el navegador con el panel del hilo a la vista). Sin seguirlo, no cambia nada. */
  async markThreadRead(actor: Actor, rootId: string, threadSeq: number): Promise<{ lastReadThreadSeq: number | null; unreadCount: number; mentionCount: number }> {
    const root = await this.get(actor, rootId);
    if (root.threadRootId !== null) throw new MessageNotFoundError();
    const cursor = await this.repos.threadFollowers.markRead(root.id, actor.userId, threadSeq);
    if (cursor === null) return { lastReadThreadSeq: null, unreadCount: 0, mentionCount: 0 };
    const k = (await this.repos.threadFollowers.counts(actor.userId, [{ threadRootId: root.id, lastReadThreadSeq: cursor }])).get(root.id);
    return { lastReadThreadSeq: cursor, unreadCount: k?.unread ?? 0, mentionCount: k?.mentions ?? 0 };
  }

  /** Editar mi mensaje: sin historial (decisión «privado»), queda `editedAt`. Las menciones nuevas no vuelven a avisar. */
  async edit(actor: Actor, messageId: string, bodyDoc: unknown): Promise<Message> {
    let parsed;
    try {
      parsed = parseRichText(bodyDoc);
    } catch (err) {
      if (err instanceof RichTextError) throw new ValidationError([{ field: 'bodyDoc', message: err.message }]);
      throw err;
    }
    if (parsed.isEmpty) throw new ValidationError([{ field: 'bodyDoc', message: 'El mensaje está vacío. Para quitarlo, bórralo.' }]);
    return inTransaction(this.gateway, async (uow) => {
      const { c, m, me } = await this.writableMessage(uow, actor, messageId);
      if (!canEdit(actor, m)) throw new ForbiddenError('Solo quien lo escribió puede editar un mensaje.');
      if (!canWrite(c, me)) throw c.archivedAt ? new ConversationArchivedError() : new ForbiddenError();
      m.bodyDoc = parsed.doc;
      m.bodyText = parsed.text;
      m.editedAt = this.clock();
      await uow.messages.update(m);
      await uow.outbox.add(messageUpdatedEvent(c, m, (await uow.members.list(c.id)).map((x) => x.userId).filter((u) => u !== actor.userId)));
      return m;
    });
  }

  /** Borrar para todos: el autor; en canales, también `chat:admin`. Se borra el TEXTO; queda la lápida para no romper el hilo. */
  async remove(actor: Actor, messageId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const { c, m } = await this.writableMessage(uow, actor, messageId);
      if (!canDelete(actor, c, m)) throw new ForbiddenError('No puedes borrar este mensaje.');
      if (c.archivedAt) throw new ConversationArchivedError();
      m.bodyDoc = null;
      m.bodyText = null;
      m.deletedAt = this.clock();
      m.deletedBy = actor.userId;
      await uow.messages.update(m);
      await uow.outbox.add(messageDeletedEvent(c, m, (await uow.members.list(c.id)).map((x) => x.userId).filter((u) => u !== actor.userId), m.senderId !== actor.userId));
    });
  }

  /** Reaccionar o quitar mi reacción. Idempotente: dos veces lo mismo es lo mismo (y un solo evento). */
  async react(actor: Actor, messageId: string, emoji: string, add: boolean): Promise<ReactionGroup[]> {
    const e = emoji.trim();
    const custom = customReactionName(e);
    if (!custom && !EMOJI.test(e)) throw new ValidationError([{ field: 'emoji', message: 'Reacción inválida.' }]);
    // Un personalizado tiene que existir para reaccionar con él (quitar una reacción vieja siempre se puede, aunque lo hayan borrado).
    if (custom && add && !(await this.repos.emojis.findByName(actor.organizationId, custom))) {
      throw new ValidationError([{ field: 'emoji', message: `El emoji :${custom}: no existe.` }]);
    }
    await inTransaction(this.gateway, async (uow) => {
      const { c, m, me } = await this.writableMessage(uow, actor, messageId);
      if (m.deletedAt) throw new MessageNotFoundError();
      if (add && !canWrite(c, me)) throw c.archivedAt ? new ConversationArchivedError() : new ForbiddenError('Únete al canal para reaccionar.');
      const changed = add
        ? await uow.reactions.add({ messageId: m.id, userId: actor.userId, emoji: e, organizationId: c.organizationId, at: this.clock() })
        : await uow.reactions.remove(m.id, actor.userId, e);
      if (changed) await uow.outbox.add(reactionEvent(add, c, m, e, actor.userId, (await uow.members.list(c.id)).map((x) => x.userId)));
    });
    return (await this.repos.reactions.groupsFor([messageId])).get(messageId) ?? [];
  }

  /** Reacciones de una página de mensajes (para las respuestas HTTP). */
  async reactionsFor(messageIds: string[]): Promise<Map<string, ReactionGroup[]>> {
    return this.repos.reactions.groupsFor(messageIds);
  }

  /** Búsqueda en lo legible (ver `domain/search.ts`), más recientes primero, paginada por cursor. */
  async search(actor: Actor, input: SearchInput): Promise<{ items: SearchHit[]; nextCursor: string | null }> {
    const terms = searchTerms(input.q);
    if (terms.join('').length < 2) throw new ValidationError([{ field: 'q', message: 'Escribe al menos 2 letras.' }]);
    const before = input.cursor ? decodeCursor(input.cursor) : null;
    if (input.cursor && !before) throw new ValidationError([{ field: 'cursor', message: 'Cursor inválido.' }]);
    // Uno de más para saber si hay otra página sin contar.
    const found = await this.repos.messages.search({
      organizationId: actor.organizationId,
      userId: actor.userId,
      booleanQuery: booleanQuery(terms),
      likeTerms: shortTerms(terms),
      conversationId: input.conversationId,
      fromUserId: input.fromUserId,
      before: before ?? undefined,
      limit: input.limit + 1,
    });
    const page = found.slice(0, input.limit);
    const conversations = new Map<string, Conversation>();
    for (const id of new Set(page.map((m) => m.conversationId))) {
      const c = await this.repos.conversations.findById(actor.organizationId, id);
      if (c) conversations.set(id, c);
    }
    const items = page
      .filter((m) => conversations.has(m.conversationId))
      .map((m) => ({ message: m, conversation: conversations.get(m.conversationId)!, snippet: snippet(m.bodyText ?? '', terms) }));
    const last = page[page.length - 1];
    return { items, nextCursor: found.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  /** Para el hub del gateway (`/internal/messages/:id`): los eventos no llevan texto. */
  async internalGet(organizationId: string, messageId: string): Promise<Message> {
    const m = await this.repos.messages.findById(organizationId, messageId);
    if (!m) throw new MessageNotFoundError();
    return m;
  }

  /** El mensaje, su conversación y mi fila de miembro, con la regla de lectura (sin acceso = 404). */
  private async writableMessage(uow: Repositories, actor: Actor, messageId: string): Promise<{ c: Conversation; m: Message; me: Member | null }> {
    const m = await uow.messages.findByIdForUpdate(actor.organizationId, messageId);
    if (!m) throw new MessageNotFoundError();
    const c = await uow.conversations.findById(actor.organizationId, m.conversationId);
    if (!c) throw new MessageNotFoundError();
    const me = await uow.members.find(c.id, actor.userId);
    if (!canRead(c, me)) throw new MessageNotFoundError();
    return { c, m, me };
  }

  /** En un DM 1-a-1, si la otra persona está inactiva, la conversación queda de solo lectura. */
  private async assertDmWritable(uow: Repositories, c: Conversation, members: Member[], actor: Actor): Promise<void> {
    if (c.kind !== 'dm') return;
    const others = members.map((m) => m.userId).filter((u) => u !== actor.userId);
    if ((await uow.inactiveUsers.inactiveAmong(c.organizationId, others)).size) throw new UserInactiveError();
  }

  private newMember(c: Conversation, userId: string): Member {
    return { conversationId: c.id, userId, organizationId: c.organizationId, role: 'member', notify: 'mentions', muted: false, lastReadSeq: 0, joinedAt: this.clock() };
  }
}
