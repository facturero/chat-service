import { randomUUID } from 'node:crypto';
import type { TeamDirectory, UnitOfWorkGateway, WriteUnitOfWork } from '../application/ports.js';
import { ConversationUseCases } from '../application/use-cases/conversation-use-cases.js';
import { MessageUseCases, SendRateLimiter } from '../application/use-cases/message-use-cases.js';
import { EmojiUseCases } from '../application/use-cases/emoji-use-cases.js';
import type { DomainEvent, Repositories, UnreadCounts } from '../domain/repositories.js';
import type { Actor, Conversation, CustomEmoji, Member, Mention, Message } from '../domain/types.js';
import { createApp } from '../interface/http/app.js';

/**
 * Repositorios en memoria con la MISMA semántica que los de MySQL: filtro por organización, «insertar si no existe» contra las mismas
 * claves únicas, orden por `seq`. Las transacciones se serializan con un cerrojo (como el `FOR UPDATE` de la conversación) y copian el
 * estado al empezar: deshacer lo descarta entero, fila y evento.
 */
interface State {
  conversations: Map<string, Conversation>;
  members: Map<string, Member>;
  messages: Map<string, Message>;
  mentions: Map<string, Mention>;
  reactions: Array<{ messageId: string; userId: string; emoji: string; organizationId: string; at: Date }>;
  /** `raíz|persona` → cursor de leído del hilo (`last_read_thread_seq`). */
  followers: Map<string, number>;
  inactive: Map<string, Date>;
  emojis: Map<string, CustomEmoji>;
  outbox: DomainEvent[];
}

const emptyState = (): State => ({ conversations: new Map(), members: new Map(), messages: new Map(), mentions: new Map(), reactions: [], followers: new Map(), inactive: new Map(), emojis: new Map(), outbox: [] });
const clone = (s: State): State => ({
  conversations: new Map([...s.conversations].map(([k, v]) => [k, { ...v }])),
  members: new Map([...s.members].map(([k, v]) => [k, { ...v }])),
  messages: new Map([...s.messages].map(([k, v]) => [k, { ...v }])),
  mentions: new Map(s.mentions),
  reactions: s.reactions.map((r) => ({ ...r })),
  followers: new Map(s.followers),
  emojis: new Map(s.emojis),
  inactive: new Map(s.inactive),
  outbox: [...s.outbox],
});
const memberKey = (conversationId: string, userId: string) => `${conversationId}|${userId}`;

function repositoriesOver(get: () => State): Repositories {
  const s = get;
  return {
    conversations: {
      async findById(org, id) { const c = s().conversations.get(id); return c && c.organizationId === org ? { ...c } : null; },
      async findByIdForUpdate(org, id) { const c = s().conversations.get(id); return c && c.organizationId === org ? { ...c } : null; },
      async findGeneral(org) { const c = [...s().conversations.values()].find((x) => x.organizationId === org && x.isGeneral); return c ? { ...c } : null; },
      async findByNameKey(org, key) { const c = [...s().conversations.values()].find((x) => x.organizationId === org && x.nameKey === key); return c ? { ...c } : null; },
      async findByDmKey(org, key) { const c = [...s().conversations.values()].find((x) => x.organizationId === org && x.dmKey === key); return c ? { ...c } : null; },
      async insertIfAbsent(c) {
        const clash = [...s().conversations.values()].some(
          (x) => x.organizationId === c.organizationId && ((c.nameKey !== null && x.nameKey === c.nameKey) || (c.dmKey !== null && x.dmKey === c.dmKey)),
        );
        if (clash || s().conversations.has(c.id)) return false;
        s().conversations.set(c.id, { ...c });
        return true;
      },
      async update(c) { s().conversations.set(c.id, { ...c }); },
      async listForMember(org, userId, includeArchived) {
        return [...s().members.values()]
          .filter((m) => m.organizationId === org && m.userId === userId)
          .map((m) => ({ conversation: { ...s().conversations.get(m.conversationId)! }, me: { ...m } }))
          .filter((r) => includeArchived || r.conversation.archivedAt === null);
      },
      async browseChannels(org, userId, q, includeArchived) {
        return [...s().conversations.values()]
          .filter((c) => c.organizationId === org && c.kind === 'channel' && (includeArchived || c.archivedAt === null))
          .filter((c) => c.visibility === 'public' || s().members.has(memberKey(c.id, userId)))
          .filter((c) => !q || (c.name ?? '').includes(q) || (c.topic ?? '').includes(q))
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          .map((c) => ({ conversation: { ...c }, memberCount: [...s().members.values()].filter((m) => m.conversationId === c.id).length, isMember: s().members.has(memberKey(c.id, userId)) }));
      },
    },
    members: {
      async find(cid, uid) { const m = s().members.get(memberKey(cid, uid)); return m ? { ...m } : null; },
      async insertIfAbsent(m) { if (s().members.has(memberKey(m.conversationId, m.userId))) return false; s().members.set(memberKey(m.conversationId, m.userId), { ...m }); return true; },
      async remove(cid, uid) { return s().members.delete(memberKey(cid, uid)); },
      async list(cid) { return [...s().members.values()].filter((m) => m.conversationId === cid).map((m) => ({ ...m })); },
      async userIdsByConversation(ids) {
        const out = new Map<string, string[]>();
        for (const m of s().members.values()) if (ids.includes(m.conversationId)) out.set(m.conversationId, [...(out.get(m.conversationId) ?? []), m.userId]);
        return out;
      },
      async count(cid) { return [...s().members.values()].filter((m) => m.conversationId === cid).length; },
      async advanceRead(cid, uid, seq) { const m = s().members.get(memberKey(cid, uid)); if (!m) return 0; m.lastReadSeq = Math.max(m.lastReadSeq, seq); return m.lastReadSeq; },
      async updatePreferences(cid, uid, prefs) { const m = s().members.get(memberKey(cid, uid)); if (!m) return; if (prefs.notify) m.notify = prefs.notify; if (prefs.muted !== undefined) m.muted = prefs.muted; },
      async channelIdsOf(org, uid) {
        return [...s().members.values()].filter((m) => m.organizationId === org && m.userId === uid && s().conversations.get(m.conversationId)?.kind === 'channel').map((m) => m.conversationId);
      },
    },
    messages: {
      async insertIfAbsent(m) {
        const clash = [...s().messages.values()].some(
          (x) => x.conversationId === m.conversationId && ((m.seq !== null && x.seq === m.seq) || (m.clientMsgId !== null && x.clientMsgId === m.clientMsgId)),
        );
        if (clash) return false;
        // Como MySQL: el documento sale del JSON y vuelve como copia, no la misma referencia.
        s().messages.set(m.id, { ...m, bodyDoc: m.bodyDoc ? structuredClone(m.bodyDoc) : null });
        return true;
      },
      async findByClientMsgId(cid, client) { const m = [...s().messages.values()].find((x) => x.conversationId === cid && x.clientMsgId === client); return m ? { ...m } : null; },
      async findById(org, id) { const m = s().messages.get(id); return m && m.organizationId === org ? { ...m } : null; },
      async findByIdForUpdate(org, id) { const m = s().messages.get(id); return m && m.organizationId === org ? { ...m } : null; },
      async update(m) { s().messages.set(m.id, { ...m, bodyDoc: m.bodyDoc ? structuredClone(m.bodyDoc) : null, replyUserIds: [...m.replyUserIds] }); },
      async latestReplies(rootId, n) {
        return [...s().messages.values()].filter((m) => m.threadRootId === rootId).sort((a, b) => a.threadSeq! - b.threadSeq!).slice(-n).map((m) => ({ ...m }));
      },
      async listReplies(rootId, q) {
        return [...s().messages.values()]
          .filter((m) => m.threadRootId === rootId && (q.after === undefined || m.threadSeq! > q.after))
          .sort((a, b) => a.threadSeq! - b.threadSeq!)
          .slice(0, q.limit)
          .map((m) => ({ ...m }));
      },
      async listRoots(cid, q) {
        const roots = [...s().messages.values()].filter((m) => m.conversationId === cid && m.seq !== null).sort((a, b) => a.seq! - b.seq!);
        let list = roots.filter((m) => (q.before === undefined || m.seq! < q.before) && (q.after === undefined || m.seq! > q.after));
        list = q.after !== undefined && q.before === undefined ? list.slice(0, q.limit) : list.slice(-q.limit);
        return list.map((m) => ({ ...m }));
      },
      async hasRootBefore(cid, seq) { return [...s().messages.values()].some((m) => m.conversationId === cid && m.seq !== null && m.seq < seq); },
      async hasRootAfter(cid, seq) { return [...s().messages.values()].some((m) => m.conversationId === cid && m.seq !== null && m.seq > seq); },
      async unreadCounts(userId, cursors) {
        const out = new Map<string, UnreadCounts>();
        for (const { conversationId, lastReadSeq } of cursors) {
          const unread = [...s().messages.values()].filter(
            (m) => m.conversationId === conversationId && m.seq !== null && m.seq > lastReadSeq && m.kind === 'user' && !m.deletedAt && m.senderId !== userId,
          ).length;
          const mentions = [...s().mentions.values()].filter((x) => {
            const m = s().messages.get(x.messageId);
            return x.userId === userId && m && m.conversationId === conversationId && m.seq !== null && m.seq > lastReadSeq && !m.deletedAt;
          }).length;
          if (unread || mentions) out.set(conversationId, { unread, mentions });
        }
        return out;
      },
      async search(q) {
        // Misma regla que el SQL: legible, sin borrados ni de sistema; las palabras como prefijo (booleano) o en cualquier parte (LIKE).
        const words = (q.booleanQuery ?? '').split(' ').filter(Boolean).map((w) => w.replace(/^\+|\*$/g, ''));
        return [...s().messages.values()]
          .filter((m) => {
            const c = s().conversations.get(m.conversationId);
            if (!c || m.organizationId !== q.organizationId || m.deletedAt || m.kind !== 'user' || !m.bodyText) return false;
            if (!((c.kind === 'channel' && c.visibility === 'public') || s().members.has(memberKey(c.id, q.userId)))) return false;
            const text = m.bodyText.toLowerCase();
            const tokens = text.split(/[^\p{L}\p{N}_]+/u);
            if (!words.every((w) => tokens.some((t) => t.startsWith(w)))) return false;
            if (!q.likeTerms.every((t) => text.includes(t))) return false;
            if (q.conversationId && m.conversationId !== q.conversationId) return false;
            if (q.fromUserId && m.senderId !== q.fromUserId) return false;
            if (q.before && !(m.createdAt < q.before.createdAt || (m.createdAt.getTime() === q.before.createdAt.getTime() && m.id < q.before.id))) return false;
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, q.limit)
          .map((m) => ({ ...m }));
      },
      async latestRoots(ids) {
        const out = new Map<string, Message>();
        for (const id of ids) {
          const c = s().conversations.get(id);
          const m = [...s().messages.values()].find((x) => x.conversationId === id && x.seq === c?.messageSeq);
          if (m) out.set(id, { ...m });
        }
        return out;
      },
    },
    mentions: { async insertMany(list) { for (const m of list) s().mentions.set(`${m.messageId}|${m.userId}`, { ...m }); } },
    reactions: {
      async add(r) {
        if (s().reactions.some((x) => x.messageId === r.messageId && x.userId === r.userId && x.emoji === r.emoji)) return false;
        s().reactions.push({ ...r });
        return true;
      },
      async remove(messageId, userId, emoji) {
        const before = s().reactions.length;
        s().reactions = s().reactions.filter((x) => !(x.messageId === messageId && x.userId === userId && x.emoji === emoji));
        return s().reactions.length < before;
      },
      async groupsFor(ids) {
        const out = new Map<string, Array<{ emoji: string; userIds: string[] }>>();
        for (const r of s().reactions) {
          if (!ids.includes(r.messageId)) continue;
          const groups = out.get(r.messageId) ?? [];
          const g = groups.find((x) => x.emoji === r.emoji);
          if (g) g.userIds.push(r.userId);
          else groups.push({ emoji: r.emoji, userIds: [r.userId] });
          out.set(r.messageId, groups);
        }
        return out;
      },
    },
    threadFollowers: {
      async add(rootId, ids) { for (const u of ids) if (!s().followers.has(`${rootId}|${u}`)) s().followers.set(`${rootId}|${u}`, 0); },
      async list(rootId) { return [...s().followers.keys()].filter((k) => k.startsWith(`${rootId}|`)).map((k) => k.split('|')[1]); },
      async markRead(rootId, userId, threadSeq) {
        const key = `${rootId}|${userId}`;
        const cur = s().followers.get(key);
        if (cur === undefined) return null;
        const max = Math.max(0, ...[...s().messages.values()].filter((m) => m.threadRootId === rootId).map((m) => m.threadSeq ?? 0));
        const next = Math.max(cur, Math.min(threadSeq, max));
        s().followers.set(key, next);
        return next;
      },
      async listForUser(q) {
        const readable = (cid: string) => {
          const c = s().conversations.get(cid);
          return !!c && ((c.kind === 'channel' && c.visibility === 'public') || s().members.has(memberKey(cid, q.userId)));
        };
        return [...s().followers.entries()]
          .filter(([k]) => k.endsWith(`|${q.userId}`))
          .map(([k, cursor]) => ({ root: s().messages.get(k.split('|')[0])!, lastReadThreadSeq: cursor }))
          .filter(({ root }) => root && root.organizationId === q.organizationId && root.replyCount > 0 && root.lastReplyAt && readable(root.conversationId))
          .filter(({ root }) => !q.before || root.lastReplyAt! < q.before.lastReplyAt || (root.lastReplyAt!.getTime() === q.before.lastReplyAt.getTime() && root.id < q.before.id))
          .sort((a, b) => b.root.lastReplyAt!.getTime() - a.root.lastReplyAt!.getTime() || (a.root.id < b.root.id ? 1 : -1))
          .slice(0, q.limit)
          .map((x) => ({ root: { ...x.root }, lastReadThreadSeq: x.lastReadThreadSeq }));
      },
      async counts(userId, items) {
        const out = new Map<string, UnreadCounts>();
        for (const { threadRootId, lastReadThreadSeq } of items) {
          const replies = [...s().messages.values()].filter((m) => m.threadRootId === threadRootId && (m.threadSeq ?? 0) > lastReadThreadSeq && !m.deletedAt);
          const unread = replies.filter((m) => m.kind === 'user' && m.senderId !== userId).length;
          const mentions = replies.filter((m) => [...s().mentions.values()].some((x) => x.messageId === m.id && x.userId === userId)).length;
          if (unread || mentions) out.set(threadRootId, { unread, mentions });
        }
        return out;
      },
      async totals(org, userId) {
        const mine = await this.listForUser({ organizationId: org, userId, limit: 10_000 });
        const counts = await this.counts(userId, mine.map((x) => ({ threadRootId: x.root.id, lastReadThreadSeq: x.lastReadThreadSeq })));
        const muted = (cid: string) => !!s().members.get(memberKey(cid, userId))?.muted;
        return {
          threads: mine.filter((x) => (counts.get(x.root.id)?.unread ?? 0) > 0 && !muted(x.root.conversationId)).length,
          mentions: [...counts.values()].reduce((n, c) => n + c.mentions, 0),
        };
      },
    },
    inactiveUsers: {
      async mark(org, uid, since) { if (!s().inactive.has(`${org}|${uid}`)) s().inactive.set(`${org}|${uid}`, since); },
      async clear(org, uid) { s().inactive.delete(`${org}|${uid}`); },
      async inactiveAmong(org, ids) { return new Set(ids.filter((u) => s().inactive.has(`${org}|${u}`))); },
    },
    emojis: {
      async list(org) { return [...s().emojis.values()].filter((e) => e.organizationId === org).sort((a, b) => a.name.localeCompare(b.name)); },
      async findByName(org, name) { return [...s().emojis.values()].find((e) => e.organizationId === org && e.name === name) ?? null; },
      async findById(org, id) { const e = s().emojis.get(id); return e && e.organizationId === org ? e : null; },
      async insertIfAbsent(e) {
        if ([...s().emojis.values()].some((x) => x.organizationId === e.organizationId && x.name === e.name)) return false;
        s().emojis.set(e.id, { ...e });
        return true;
      },
      async remove(org, id) { const e = s().emojis.get(id); if (!e || e.organizationId !== org) return false; s().emojis.delete(id); return true; },
    },
    outbox: { async add(e) { s().outbox.push(e); } },
  };
}

export class MemoryStore implements UnitOfWorkGateway {
  state: State = emptyState();
  private queue: Promise<void> = Promise.resolve();

  /** Lecturas fuera de transacción: siempre el estado confirmado. */
  readonly repos: Repositories = repositoriesOver(() => this.state);

  async begin(): Promise<WriteUnitOfWork> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((ok) => (release = ok));
    await previous;
    const working = clone(this.state);
    const repos = repositoriesOver(() => working);
    let done = false;
    return {
      ...repos,
      commit: async () => {
        if (done) return;
        this.state = working;
        done = true;
        release();
      },
      rollback: async () => {
        if (done) return;
        done = true;
        release();
      },
    };
  }

  events(type?: string): DomainEvent[] {
    return this.state.outbox.filter((e) => !type || e.type === type);
  }
}

/** Equipo de la organización según «auth»: se puede cambiar por prueba. */
export class FakeDirectory implements TeamDirectory {
  constructor(public team: Record<string, string[]> = {}) {}
  async activeUserIds(organizationId: string): Promise<string[]> {
    return this.team[organizationId] ?? [];
  }
}

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
export const user = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const actor = (n: number, opts: { org?: string; admin?: boolean } = {}): Actor => ({
  userId: user(n),
  organizationId: opts.org ?? ORG,
  permissions: opts.admin ? ['chat:admin'] : [],
});

export const text = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
export const mentionDoc = (id: string, label = 'alguien', rest = ' hola') => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id, label } }, { type: 'text', text: rest }] }],
});

export function build(opts: { team?: string[]; rate?: number } = {}) {
  const store = new MemoryStore();
  const directory = new FakeDirectory({ [ORG]: opts.team ?? [1, 2, 3, 4, 5].map(user), [OTHER_ORG]: [user(90), user(91)] });
  let t = Date.parse('2026-11-14T12:00:00Z');
  const clock = () => new Date((t += 1000));
  const conversations = new ConversationUseCases(store, store.repos, directory, clock, randomUUID);
  const messages = new MessageUseCases(store, store.repos, new SendRateLimiter(opts.rate ?? 1000, 60_000, clock), clock, randomUUID);
  const emojis = new EmojiUseCases(store.repos, clock, randomUUID);
  const app = createApp({ useCases: { conversations, messages, emojis }, corsOrigin: '*', internalSecret: 'secreto-de-prueba' }, { log: false });
  return { store, directory, conversations, messages, emojis, app };
}
