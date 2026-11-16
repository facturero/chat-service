import { canAddMembers, canManage, canRead } from '../../domain/access.js';
import {
  ConversationArchivedError,
  ConversationNotFoundError,
  ForbiddenError,
  GeneralIsMandatoryError,
  NameTakenError,
  NotApplicableError,
  UserInactiveError,
  ValidationError,
} from '../../domain/errors.js';
import { GENERAL_NAME, channelNameKey, dmKey, normalizeChannelName } from '../../domain/names.js';
import type { ChannelListing, Repositories } from '../../domain/repositories.js';
import {
  GROUP_DM_MAX,
  GROUP_DM_MIN,
  UNREAD_CAP,
  type Actor,
  type Conversation,
  type ConversationKind,
  type ConversationView,
  type Member,
  type Message,
  type NotifyLevel,
  type Visibility,
} from '../../domain/types.js';
import {
  conversationArchivedEvent,
  conversationCreatedEvent,
  conversationReadEvent,
  conversationUnarchivedEvent,
  conversationUpdatedEvent,
  memberJoinedEvent,
  memberLeftEvent,
} from '../events.js';
import { inTransaction, type Clock, type IdGenerator, type TeamDirectory, type UnitOfWorkGateway } from '../ports.js';

export interface CreateConversationInput {
  kind: ConversationKind;
  name?: string;
  visibility?: Visibility;
  topic?: string;
  description?: string;
  userIds?: string[];
}

export interface ConversationDetail extends ConversationView {
  memberCount: number;
  isMember: boolean;
}

export interface InboxSummary {
  conversations: number;
  mentions: number;
  /** Hilos que sigo con respuestas nuevas, y menciones dentro de hilos (no suman a `mentions`: esas son de los canales). */
  threads: { unread: number; mentions: number };
  latest: Array<{ view: ConversationView; lastMessage: Message }>;
}

/**
 * Conversaciones: canales, DMs, miembros, leído y preferencias (entregable 1). Reglas de acceso en `domain/access.ts`; quien no puede
 * leer recibe 404.
 */
export class ConversationUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly directory: TeamDirectory,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  // ── #general ──────────────────────────────────────────────────────────────

  /**
   * `#general` se crea solo, la primera vez que alguien de la organización abre la mensajería, con TODO el equipo activo (contactos de
   * auth). Si ya existe y quien llega no está (entró al equipo antes de que corriera el consumidor), entra ahora.
   * Dos primeras visitas a la vez: el UNIQUE `(organization_id, name_key)` deja crear una sola; la otra solo se une.
   */
  async ensureGeneral(actor: Actor): Promise<Conversation> {
    const existing = await this.repos.conversations.findGeneral(actor.organizationId);
    if (existing) {
      if (!(await this.repos.members.find(existing.id, actor.userId))) {
        await inTransaction(this.gateway, async (uow) => {
          if (await uow.members.insertIfAbsent(this.newMember(existing, actor.userId, 'member', 'mentions'))) {
            await uow.outbox.add(memberJoinedEvent(existing, [actor.userId], [], 'onboarding'));
          }
        });
      }
      return existing;
    }

    // Fuera de la transacción: es una llamada HTTP a auth y no debe alargar el bloqueo.
    const team = new Set(await this.directory.activeUserIds(actor.organizationId));
    team.add(actor.userId);
    const now = this.clock();
    const general: Conversation = {
      ...this.blankConversation(actor, 'channel', now),
      visibility: 'public',
      name: GENERAL_NAME,
      nameKey: GENERAL_NAME,
      isGeneral: true,
      topic: null,
    };
    return inTransaction(this.gateway, async (uow) => {
      if (!(await uow.conversations.insertIfAbsent(general))) {
        const winner = await uow.conversations.findGeneral(actor.organizationId);
        if (!winner) throw new Error('#general no se pudo crear ni leer');
        await uow.members.insertIfAbsent(this.newMember(winner, actor.userId, 'member', 'mentions'));
        return winner;
      }
      for (const userId of team) await uow.members.insertIfAbsent(this.newMember(general, userId, userId === actor.userId ? 'owner' : 'member', 'mentions'));
      await uow.outbox.add(conversationCreatedEvent(general, [...team]));
      return general;
    });
  }

  // ── Lecturas ──────────────────────────────────────────────────────────────

  async list(actor: Actor, includeArchived: boolean): Promise<ConversationView[]> {
    await this.ensureGeneral(actor);
    const rows = await this.repos.conversations.listForMember(actor.organizationId, actor.userId, includeArchived);
    const views = await this.views(actor, rows);
    return views.sort((a, b) => (b.conversation.lastMessageAt?.getTime() ?? 0) - (a.conversation.lastMessageAt?.getTime() ?? 0));
  }

  async browse(actor: Actor, q: string | null, includeArchived: boolean): Promise<ChannelListing[]> {
    await this.ensureGeneral(actor);
    return this.repos.conversations.browseChannels(actor.organizationId, actor.userId, q?.trim() || null, includeArchived);
  }

  async get(actor: Actor, conversationId: string): Promise<ConversationDetail> {
    const { conversation, me } = await this.readable(actor, conversationId);
    const [view] = await this.views(actor, [{ conversation, me }]);
    return { ...view, memberCount: await this.repos.members.count(conversation.id), isMember: me !== null };
  }

  async members(actor: Actor, conversationId: string): Promise<Array<Member & { inactive: boolean }>> {
    const { conversation } = await this.readable(actor, conversationId);
    const list = await this.repos.members.list(conversation.id);
    const inactive = await this.repos.inactiveUsers.inactiveAmong(actor.organizationId, list.map((m) => m.userId));
    return list.map((m) => ({ ...m, inactive: inactive.has(m.userId) }));
  }

  /** Totales para la barra superior, el menú lateral y el widget: sin silenciados en el recuento de conversaciones. */
  async unread(actor: Actor): Promise<InboxSummary> {
    const rows = await this.repos.conversations.listForMember(actor.organizationId, actor.userId, false);
    const views = await this.views(actor, rows);
    const pending = views.filter((v) => v.unreadCount > 0 || v.mentionCount > 0);
    const latest = await this.repos.messages.latestRoots(pending.map((v) => v.conversation.id));
    const threads = await this.repos.threadFollowers.totals(actor.organizationId, actor.userId);
    return {
      conversations: pending.filter((v) => !v.me?.muted).length,
      mentions: pending.reduce((n, v) => n + v.mentionCount, 0),
      threads: { unread: threads.threads, mentions: threads.mentions },
      latest: pending
        .filter((v) => latest.has(v.conversation.id))
        .sort((a, b) => (b.conversation.lastMessageAt?.getTime() ?? 0) - (a.conversation.lastMessageAt?.getTime() ?? 0))
        .slice(0, 10)
        .map((view) => ({ view, lastMessage: latest.get(view.conversation.id)! })),
    };
  }

  // ── Crear ─────────────────────────────────────────────────────────────────

  async create(actor: Actor, input: CreateConversationInput): Promise<{ conversation: ConversationDetail; existed: boolean }> {
    await this.ensureGeneral(actor);
    const id = input.kind === 'channel' ? await this.createChannel(actor, input) : await this.openDm(actor, input);
    return { conversation: await this.get(actor, id.id), existed: id.existed };
  }

  private async createChannel(actor: Actor, input: CreateConversationInput): Promise<{ id: string; existed: boolean }> {
    const name = normalizeChannelName(input.name ?? '');
    if (!name) throw new ValidationError([{ field: 'name', message: 'El canal necesita un nombre (letras, números, - o _).' }]);
    const nameKey = channelNameKey(name);
    if (nameKey === GENERAL_NAME) throw new NameTakenError();
    const extra = await this.validTeammates(actor, input.userIds ?? []);
    const now = this.clock();
    const channel: Conversation = {
      ...this.blankConversation(actor, 'channel', now),
      visibility: input.visibility ?? 'public',
      name,
      nameKey,
      topic: input.topic?.trim() || null,
      description: input.description?.trim() || null,
    };
    await inTransaction(this.gateway, async (uow) => {
      if (!(await uow.conversations.insertIfAbsent(channel))) throw new NameTakenError();
      const memberIds = [actor.userId, ...extra];
      for (const userId of memberIds) await uow.members.insertIfAbsent(this.newMember(channel, userId, userId === actor.userId ? 'owner' : 'member', 'mentions'));
      await uow.outbox.add(conversationCreatedEvent(channel, memberIds));
    });
    return { id: channel.id, existed: false };
  }

  /** DM idempotente: mismas personas → la misma conversación (`dm_key`). Dos «abrir» a la vez: INSERT IGNORE + leer la ganadora. */
  private async openDm(actor: Actor, input: CreateConversationInput): Promise<{ id: string; existed: boolean }> {
    const others = [...new Set((input.userIds ?? []).map((u) => u.toLowerCase()))].filter((u) => u !== actor.userId.toLowerCase());
    if (input.kind === 'dm' && others.length !== 1) throw new ValidationError([{ field: 'userIds', message: 'Un mensaje directo es con exactamente una persona.' }]);
    if (input.kind === 'group_dm' && (others.length < GROUP_DM_MIN || others.length > GROUP_DM_MAX)) {
      throw new ValidationError([{ field: 'userIds', message: `Un grupo es de ${GROUP_DM_MIN} a ${GROUP_DM_MAX} personas además de ti.` }]);
    }
    const valid = await this.validTeammates(actor, others);
    const participants = [actor.userId, ...valid];
    const key = dmKey(participants);
    const found = await this.repos.conversations.findByDmKey(actor.organizationId, key);
    if (found) return { id: found.id, existed: true };

    const dm: Conversation = { ...this.blankConversation(actor, input.kind, this.clock()), dmKey: key };
    return inTransaction(this.gateway, async (uow) => {
      if (!(await uow.conversations.insertIfAbsent(dm))) {
        const winner = await uow.conversations.findByDmKey(actor.organizationId, key);
        if (!winner) throw new Error('DM no se pudo crear ni leer');
        return { id: winner.id, existed: true };
      }
      for (const userId of participants) await uow.members.insertIfAbsent(this.newMember(dm, userId, 'member', 'all'));
      await uow.outbox.add(conversationCreatedEvent(dm, participants));
      return { id: dm.id, existed: false };
    });
  }

  // ── Cambiar ───────────────────────────────────────────────────────────────

  async update(actor: Actor, conversationId: string, input: { name?: string; topic?: string | null; description?: string | null }): Promise<ConversationDetail> {
    await inTransaction(this.gateway, async (uow) => {
      const { conversation: c, me } = await this.readableIn(uow, actor, conversationId);
      if (!canManage(actor, c, me)) throw new ForbiddenError();
      if (c.archivedAt) throw new ConversationArchivedError();
      const changes: string[] = [];
      if (input.name !== undefined) {
        const name = normalizeChannelName(input.name);
        if (!name) throw new ValidationError([{ field: 'name', message: 'El canal necesita un nombre (letras, números, - o _).' }]);
        if (c.isGeneral && name !== c.name) throw new GeneralIsMandatoryError('#general no se puede renombrar.');
        const nameKey = channelNameKey(name);
        if (nameKey !== c.nameKey) {
          if (nameKey === GENERAL_NAME || (await uow.conversations.findByNameKey(c.organizationId, nameKey))) throw new NameTakenError();
          c.name = name;
          c.nameKey = nameKey;
          changes.push('name');
        }
      }
      if (input.topic !== undefined && (input.topic?.trim() || null) !== c.topic) {
        c.topic = input.topic?.trim() || null;
        changes.push('topic');
      }
      if (input.description !== undefined && (input.description?.trim() || null) !== c.description) {
        c.description = input.description?.trim() || null;
        changes.push('description');
      }
      if (!changes.length) return;
      c.updatedAt = this.clock();
      await uow.conversations.update(c);
      await uow.outbox.add(conversationUpdatedEvent(c, await this.memberIds(uow, c), changes));
    });
    return this.get(actor, conversationId);
  }

  async setArchived(actor: Actor, conversationId: string, archived: boolean): Promise<ConversationDetail> {
    await inTransaction(this.gateway, async (uow) => {
      const { conversation: c, me } = await this.readableIn(uow, actor, conversationId);
      if (!canManage(actor, c, me)) throw new ForbiddenError();
      if (c.isGeneral) throw new GeneralIsMandatoryError();
      if ((c.archivedAt !== null) === archived) return; // idempotente
      c.archivedAt = archived ? this.clock() : null;
      c.updatedAt = this.clock();
      await uow.conversations.update(c);
      const ids = await this.memberIds(uow, c);
      await uow.outbox.add(archived ? conversationArchivedEvent(c, ids) : conversationUnarchivedEvent(c, ids));
    });
    return this.get(actor, conversationId);
  }

  // ── Miembros ──────────────────────────────────────────────────────────────

  async join(actor: Actor, conversationId: string): Promise<ConversationDetail> {
    await inTransaction(this.gateway, async (uow) => {
      const { conversation: c } = await this.readableIn(uow, actor, conversationId);
      if (c.kind !== 'channel') throw new NotApplicableError();
      if (c.archivedAt) throw new ConversationArchivedError();
      if (await uow.members.insertIfAbsent(this.newMember(c, actor.userId, 'member', 'mentions'))) {
        await uow.outbox.add(memberJoinedEvent(c, [actor.userId], await this.memberIds(uow, c), 'joined'));
      }
    });
    return this.get(actor, conversationId);
  }

  async addMembers(actor: Actor, conversationId: string, userIds: string[]): Promise<Array<Member & { inactive: boolean }>> {
    const valid = await this.validTeammates(actor, userIds);
    await inTransaction(this.gateway, async (uow) => {
      const { conversation: c, me } = await this.readableIn(uow, actor, conversationId);
      if (c.archivedAt) throw new ConversationArchivedError();
      if (!canAddMembers(c, me)) throw c.kind === 'channel' ? new ForbiddenError('Únete al canal para agregar personas.') : new NotApplicableError();
      const added: string[] = [];
      for (const userId of valid) if (await uow.members.insertIfAbsent(this.newMember(c, userId, 'member', 'mentions'))) added.push(userId);
      if (added.length) await uow.outbox.add(memberJoinedEvent(c, added, await this.memberIds(uow, c), 'added'));
    });
    return this.members(actor, conversationId);
  }

  /** Salir (mi id) o quitar a otro (dueño o `chat:admin`). Nadie sale de #general ni de un DM. */
  async removeMember(actor: Actor, conversationId: string, userId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const { conversation: c, me } = await this.readableIn(uow, actor, conversationId);
      if (c.kind !== 'channel') throw new NotApplicableError('De un mensaje directo no se sale.');
      if (c.isGeneral) throw new GeneralIsMandatoryError();
      const self = userId.toLowerCase() === actor.userId.toLowerCase();
      if (!self && !canManage(actor, c, me)) throw new ForbiddenError();
      if (!(await uow.members.remove(c.id, userId))) return; // ya no estaba: idempotente
      await uow.outbox.add(memberLeftEvent(c, [userId], await this.memberIds(uow, c), self ? 'left' : 'removed'));
    });
  }

  // ── Leído y preferencias ──────────────────────────────────────────────────

  async markRead(actor: Actor, conversationId: string, seq: number): Promise<{ lastReadSeq: number; unreadCount: number; mentionCount: number }> {
    const { conversation: c, me } = await this.readable(actor, conversationId);
    if (!me) return { lastReadSeq: 0, unreadCount: 0, mentionCount: 0 }; // canal público sin unirse: no hay cursor
    const target = Math.min(Math.max(0, Math.floor(seq)), c.messageSeq);
    let lastReadSeq = me.lastReadSeq;
    if (target > me.lastReadSeq) {
      lastReadSeq = await inTransaction(this.gateway, async (uow) => {
        const cursor = await uow.members.advanceRead(c.id, actor.userId, target);
        if (cursor > me.lastReadSeq) await uow.outbox.add(conversationReadEvent(c, actor.userId, cursor));
        return cursor;
      });
    }
    const counts = (await this.repos.messages.unreadCounts(actor.userId, [{ conversationId: c.id, lastReadSeq }])).get(c.id);
    return { lastReadSeq, unreadCount: Math.min(counts?.unread ?? 0, UNREAD_CAP), mentionCount: Math.min(counts?.mentions ?? 0, UNREAD_CAP) };
  }

  async setPreferences(actor: Actor, conversationId: string, prefs: { notify?: NotifyLevel; muted?: boolean }): Promise<Member> {
    const { conversation: c, me } = await this.readable(actor, conversationId);
    if (!me) throw new ConversationNotFoundError();
    await this.repos.members.updatePreferences(c.id, actor.userId, prefs);
    return { ...me, ...(prefs.notify ? { notify: prefs.notify } : {}), ...(prefs.muted !== undefined ? { muted: prefs.muted } : {}) };
  }

  // ── Interno (hub del gateway) ─────────────────────────────────────────────

  async internalMemberIds(organizationId: string, conversationId: string): Promise<string[]> {
    const c = await this.repos.conversations.findById(organizationId, conversationId);
    if (!c) throw new ConversationNotFoundError();
    return (await this.repos.members.list(c.id)).map((m) => m.userId);
  }

  // ── Consumidor de auth (identity.user.*) ──────────────────────────────────

  /** Llegó al equipo: entra a #general (si ya existe; si no, entrará cuando alguien lo cree). */
  async onUserJoinedOrganization(organizationId: string, userId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      await uow.inactiveUsers.clear(organizationId, userId);
      const general = await uow.conversations.findGeneral(organizationId);
      if (general && (await uow.members.insertIfAbsent(this.newMember(general, userId, 'member', 'mentions')))) {
        await uow.outbox.add(memberJoinedEvent(general, [userId], [], 'onboarding'));
      }
    });
  }

  /** Deshabilitado: sale de todos los canales (sus DMs quedan de solo lectura por `inactive_users`). */
  async onUserDisabled(organizationId: string, userId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      await uow.inactiveUsers.mark(organizationId, userId, this.clock());
      for (const conversationId of await uow.members.channelIdsOf(organizationId, userId)) {
        const c = await uow.conversations.findById(organizationId, conversationId);
        if (!c || !(await uow.members.remove(c.id, userId))) continue;
        await uow.outbox.add(memberLeftEvent(c, [userId], await this.memberIds(uow, c), 'deactivated'));
      }
    });
  }

  // ── Ayudantes ─────────────────────────────────────────────────────────────

  private async readable(actor: Actor, conversationId: string): Promise<{ conversation: Conversation; me: Member | null }> {
    return this.readableIn(this.repos, actor, conversationId);
  }

  private async readableIn(repos: Repositories, actor: Actor, conversationId: string): Promise<{ conversation: Conversation; me: Member | null }> {
    const conversation = await repos.conversations.findById(actor.organizationId, conversationId);
    if (!conversation) throw new ConversationNotFoundError();
    const me = await repos.members.find(conversation.id, actor.userId);
    if (!canRead(conversation, me)) throw new ConversationNotFoundError();
    return { conversation, me };
  }

  /** Quienes se pueden sumar: miembros ACTIVOS de la organización según auth (un id inventado o de otra empresa no entra). */
  private async validTeammates(actor: Actor, userIds: string[]): Promise<string[]> {
    const wanted = [...new Set(userIds.map((u) => u.toLowerCase()))].filter((u) => u !== actor.userId.toLowerCase());
    if (!wanted.length) return [];
    const team = new Set((await this.directory.activeUserIds(actor.organizationId)).map((u) => u.toLowerCase()));
    const outsiders = wanted.filter((u) => !team.has(u));
    if (outsiders.length) throw new ValidationError([{ field: 'userIds', message: 'Alguna de esas personas no es miembro activo de la organización.' }]);
    const inactive = await this.repos.inactiveUsers.inactiveAmong(actor.organizationId, wanted);
    if (inactive.size) throw new UserInactiveError();
    return wanted;
  }

  private async views(actor: Actor, rows: Array<{ conversation: Conversation; me: Member | null }>): Promise<ConversationView[]> {
    const dmIds = rows.filter((r) => r.conversation.kind !== 'channel').map((r) => r.conversation.id);
    const participants = await this.repos.members.userIdsByConversation(dmIds);
    const counts = await this.repos.messages.unreadCounts(
      actor.userId,
      rows.filter((r) => r.me).map((r) => ({ conversationId: r.conversation.id, lastReadSeq: r.me!.lastReadSeq })),
    );
    return rows.map(({ conversation, me }) => {
      const c = counts.get(conversation.id);
      // En un DM, cada mensaje sin leer cuenta como mención (le hablaron a uno): es lo que suma el globo rojo de Slack.
      const mentions = conversation.kind === 'channel' ? (c?.mentions ?? 0) : (c?.unread ?? 0);
      return {
        conversation,
        me,
        participantUserIds: (participants.get(conversation.id) ?? []).filter((u) => u !== actor.userId),
        unreadCount: Math.min(c?.unread ?? 0, UNREAD_CAP),
        mentionCount: Math.min(mentions, UNREAD_CAP),
      };
    });
  }

  private async memberIds(repos: Repositories, c: Conversation): Promise<string[]> {
    return (await repos.members.list(c.id)).map((m) => m.userId);
  }

  private blankConversation(actor: Actor, kind: ConversationKind, now: Date): Conversation {
    return {
      id: this.ids(),
      organizationId: actor.organizationId,
      kind,
      visibility: null,
      name: null,
      nameKey: null,
      topic: null,
      description: null,
      isGeneral: false,
      dmKey: null,
      createdBy: actor.userId,
      archivedAt: null,
      messageSeq: 0,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private newMember(c: Conversation, userId: string, role: 'owner' | 'member', notify: NotifyLevel): Member {
    return { conversationId: c.id, userId: userId.toLowerCase(), organizationId: c.organizationId, role, notify, muted: false, lastReadSeq: 0, joinedAt: this.clock() };
  }
}
