import { QueryTypes, type Transaction } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import type { UnitOfWorkGateway, WriteUnitOfWork } from '../../application/ports.js';
import type {
  ChannelListing,
  ConversationRepository,
  DomainEvent,
  EmojiRepository,
  InactiveUserRepository,
  MemberRepository,
  MentionRepository,
  MessagePageQuery,
  MessageRepository,
  OutboxRepository,
  ReactionGroup,
  ReactionRepository,
  Repositories,
  ThreadFollowerRepository,
  UnreadCounts,
} from '../../domain/repositories.js';
import type { Conversation, CustomEmoji, Member, Message, NotifyLevel } from '../../domain/types.js';
import { sequelize } from './sequelize.js';

/**
 * Persistencia en MySQL con SQL a la vista (regla 15 de IMPLEMENTATION.md): los «insertar si no existe» son `INSERT IGNORE` contra un
 * UNIQUE, el `seq` se decide con `SELECT … FOR UPDATE` y la lectura tras perder una carrera usa `LOCK IN SHARE MODE`. Así la concurrencia
 * se ve en el código y `scripts/verify-chat.mjs` la prueba contra MySQL real.
 *
 * - mysql2 ya entrega las columnas JSON decodificadas: no se vuelven a parsear (bug visto en projects-service).
 * - BIGINT y COUNT pueden llegar como texto según el driver: todo número pasa por `Number()`.
 */

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const json = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    // Algunos drivers (MariaDB) devuelven el JSON como texto; mysql2 contra MySQL ya lo decodifica.
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

function toConversation(r: Row): Conversation {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    kind: r.kind as Conversation['kind'],
    visibility: (r.visibility as Conversation['visibility']) ?? null,
    name: (r.name as string | null) ?? null,
    nameKey: (r.name_key as string | null) ?? null,
    topic: (r.topic as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    isGeneral: Boolean(r.is_general),
    dmKey: (r.dm_key as string | null) ?? null,
    createdBy: String(r.created_by),
    archivedAt: date(r.archived_at),
    messageSeq: num(r.message_seq),
    lastMessageAt: date(r.last_message_at),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
  };
}

function toMember(r: Row, prefix = ''): Member {
  return {
    conversationId: String(r[`${prefix}conversation_id`]),
    userId: String(r[`${prefix}user_id`]),
    organizationId: String(r[`${prefix}organization_id`]),
    role: r[`${prefix}role`] as Member['role'],
    notify: r[`${prefix}notify`] as NotifyLevel,
    muted: Boolean(r[`${prefix}muted`]),
    lastReadSeq: num(r[`${prefix}last_read_seq`]),
    joinedAt: date(r[`${prefix}joined_at`])!,
  };
}

/**
 * Lo que una persona puede leer (`canRead` de domain/access.ts) en SQL, con `c` = la conversación y `:userId` = quien mira: un canal
 * público, o una conversación de la que es miembro. Quien salió de un canal privado sigue en `thread_followers`, pero sus hilos ya no
 * le salen ni le cuentan.
 */
const READABLE = `((c.kind = 'channel' AND c.visibility = 'public')
  OR EXISTS (SELECT 1 FROM conversation_members rm WHERE rm.conversation_id = c.id AND rm.user_id = :userId))`;

function toMessage(r: Row): Message {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    conversationId: String(r.conversation_id),
    seq: r.seq === null ? null : num(r.seq),
    threadRootId: (r.thread_root_id as string | null) ?? null,
    threadSeq: r.thread_seq === null ? null : num(r.thread_seq),
    senderId: (r.sender_id as string | null) ?? null,
    kind: r.kind as Message['kind'],
    bodyDoc: json<Record<string, unknown> | null>(r.body_doc, null),
    bodyText: (r.body_text as string | null) ?? null,
    clientMsgId: (r.client_msg_id as string | null) ?? null,
    replyCount: num(r.reply_count),
    lastReplyAt: date(r.last_reply_at),
    replyUserIds: json<string[]>(r.reply_user_ids, []),
    editedAt: date(r.edited_at),
    deletedAt: date(r.deleted_at),
    deletedBy: (r.deleted_by as string | null) ?? null,
    createdAt: date(r.created_at)!,
  };
}

export function buildRepositories(tx?: Transaction): Repositories {
  const select = (sql: string, replacements: Record<string, unknown> = {}): Promise<Row[]> =>
    sequelize.query<Row>(sql, { replacements, type: QueryTypes.SELECT, transaction: tx });
  /** Devuelve las filas afectadas (INSERT IGNORE que chocó con un UNIQUE = 0). */
  const write = async (sql: string, replacements: Record<string, unknown> = {}): Promise<number> => {
    const [result] = await sequelize.query(sql, { replacements, transaction: tx });
    const r = result as { affectedRows?: number } | number;
    return typeof r === 'number' ? r : num(r?.affectedRows);
  };
  const lock = (mode: 'update' | 'share') => (tx ? (mode === 'update' ? ' FOR UPDATE' : ' LOCK IN SHARE MODE') : '');

  const conversations: ConversationRepository = {
    async findById(organizationId, id) {
      const [r] = await select('SELECT * FROM conversations WHERE id = :id AND organization_id = :organizationId', { id, organizationId });
      return r ? toConversation(r) : null;
    },
    async findByIdForUpdate(organizationId, id) {
      const [r] = await select(`SELECT * FROM conversations WHERE id = :id AND organization_id = :organizationId${lock('update')}`, { id, organizationId });
      return r ? toConversation(r) : null;
    },
    async findGeneral(organizationId) {
      const [r] = await select(`SELECT * FROM conversations WHERE organization_id = :organizationId AND is_general = 1 LIMIT 1${lock('share')}`, { organizationId });
      return r ? toConversation(r) : null;
    },
    async findByNameKey(organizationId, nameKey) {
      const [r] = await select('SELECT * FROM conversations WHERE organization_id = :organizationId AND name_key = :nameKey', { organizationId, nameKey });
      return r ? toConversation(r) : null;
    },
    async findByDmKey(organizationId, dmKey) {
      const [r] = await select(`SELECT * FROM conversations WHERE organization_id = :organizationId AND dm_key = :dmKey${lock('share')}`, { organizationId, dmKey });
      return r ? toConversation(r) : null;
    },
    async insertIfAbsent(c) {
      const affected = await write(
        `INSERT IGNORE INTO conversations (id, organization_id, kind, visibility, name, name_key, topic, description, is_general, dm_key,
           created_by, archived_at, message_seq, last_message_at, created_at, updated_at)
         VALUES (:id, :organizationId, :kind, :visibility, :name, :nameKey, :topic, :description, :isGeneral, :dmKey,
           :createdBy, :archivedAt, :messageSeq, :lastMessageAt, :createdAt, :updatedAt)`,
        { ...c, isGeneral: c.isGeneral ? 1 : 0 },
      );
      return affected > 0;
    },
    async update(c) {
      await write(
        `UPDATE conversations SET name = :name, name_key = :nameKey, topic = :topic, description = :description, archived_at = :archivedAt,
           message_seq = :messageSeq, last_message_at = :lastMessageAt, updated_at = :updatedAt
         WHERE id = :id AND organization_id = :organizationId`,
        c as unknown as Record<string, unknown>,
      );
    },
    async listForMember(organizationId, userId, includeArchived) {
      const rows = await select(
        `SELECT c.*, m.conversation_id AS m_conversation_id, m.user_id AS m_user_id, m.organization_id AS m_organization_id, m.role AS m_role,
                m.notify AS m_notify, m.muted AS m_muted, m.last_read_seq AS m_last_read_seq, m.joined_at AS m_joined_at
           FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.organization_id = :organizationId AND m.user_id = :userId ${includeArchived ? '' : 'AND c.archived_at IS NULL'}`,
        { organizationId, userId },
      );
      return rows.map((r) => ({ conversation: toConversation(r), me: toMember(r, 'm_') }));
    },
    async browseChannels(organizationId, userId, q, includeArchived) {
      const rows = await select(
        `SELECT c.*, (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count,
                EXISTS (SELECT 1 FROM conversation_members y WHERE y.conversation_id = c.id AND y.user_id = :userId) AS is_member
           FROM conversations c
          WHERE c.organization_id = :organizationId AND c.kind = 'channel'
            AND (c.visibility = 'public' OR EXISTS (SELECT 1 FROM conversation_members z WHERE z.conversation_id = c.id AND z.user_id = :userId))
            ${includeArchived ? '' : 'AND c.archived_at IS NULL'}
            ${q ? 'AND (c.name LIKE :q OR c.topic LIKE :q)' : ''}
          ORDER BY c.name LIMIT 500`,
        // `%` y `_` que escriba la persona son literales, no comodines.
        { organizationId, userId, q: q ? `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null },
      );
      return rows.map((r): ChannelListing => ({ conversation: toConversation(r), memberCount: num(r.member_count), isMember: Boolean(num(r.is_member)) }));
    },
  };

  const members: MemberRepository = {
    async find(conversationId, userId) {
      const [r] = await select('SELECT * FROM conversation_members WHERE conversation_id = :conversationId AND user_id = :userId', { conversationId, userId });
      return r ? toMember(r) : null;
    },
    async insertIfAbsent(m) {
      const affected = await write(
        `INSERT IGNORE INTO conversation_members (conversation_id, user_id, organization_id, role, notify, muted, last_read_seq, joined_at)
         VALUES (:conversationId, :userId, :organizationId, :role, :notify, :muted, :lastReadSeq, :joinedAt)`,
        { ...m, muted: m.muted ? 1 : 0 },
      );
      return affected > 0;
    },
    async remove(conversationId, userId) {
      return (await write('DELETE FROM conversation_members WHERE conversation_id = :conversationId AND user_id = :userId', { conversationId, userId })) > 0;
    },
    async list(conversationId) {
      const rows = await select('SELECT * FROM conversation_members WHERE conversation_id = :conversationId ORDER BY joined_at, user_id', { conversationId });
      return rows.map((r) => toMember(r));
    },
    async userIdsByConversation(conversationIds) {
      const out = new Map<string, string[]>();
      if (!conversationIds.length) return out;
      const rows = await select('SELECT conversation_id, user_id FROM conversation_members WHERE conversation_id IN (:conversationIds)', { conversationIds });
      for (const r of rows) out.set(String(r.conversation_id), [...(out.get(String(r.conversation_id)) ?? []), String(r.user_id)]);
      return out;
    },
    async count(conversationId) {
      const [r] = await select('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = :conversationId', { conversationId });
      return num(r?.n);
    },
    async advanceRead(conversationId, userId, seq) {
      await write(
        'UPDATE conversation_members SET last_read_seq = GREATEST(last_read_seq, :seq) WHERE conversation_id = :conversationId AND user_id = :userId',
        { conversationId, userId, seq },
      );
      const [r] = await select('SELECT last_read_seq FROM conversation_members WHERE conversation_id = :conversationId AND user_id = :userId', { conversationId, userId });
      return num(r?.last_read_seq);
    },
    async updatePreferences(conversationId, userId, prefs) {
      const sets: string[] = [];
      if (prefs.notify) sets.push('notify = :notify');
      if (prefs.muted !== undefined) sets.push('muted = :muted');
      if (!sets.length) return;
      await write(`UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id = :conversationId AND user_id = :userId`, {
        conversationId,
        userId,
        notify: prefs.notify ?? null,
        muted: prefs.muted ? 1 : 0,
      });
    },
    async channelIdsOf(organizationId, userId) {
      const rows = await select(
        `SELECT m.conversation_id FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.organization_id = :organizationId AND m.user_id = :userId AND c.kind = 'channel'`,
        { organizationId, userId },
      );
      return rows.map((r) => String(r.conversation_id));
    },
  };

  const messages: MessageRepository = {
    async insertIfAbsent(m) {
      const affected = await write(
        `INSERT IGNORE INTO messages (id, organization_id, conversation_id, seq, thread_root_id, thread_seq, sender_id, kind, body_doc, body_text,
           client_msg_id, reply_count, last_reply_at, reply_user_ids, edited_at, deleted_at, deleted_by, created_at)
         VALUES (:id, :organizationId, :conversationId, :seq, :threadRootId, :threadSeq, :senderId, :kind, :bodyDoc, :bodyText,
           :clientMsgId, :replyCount, :lastReplyAt, :replyUserIds, :editedAt, :deletedAt, :deletedBy, :createdAt)`,
        {
          ...m,
          bodyDoc: m.bodyDoc === null ? null : JSON.stringify(m.bodyDoc),
          replyUserIds: JSON.stringify(m.replyUserIds),
        },
      );
      return affected > 0;
    },
    async findByClientMsgId(conversationId, clientMsgId) {
      const [r] = await select('SELECT * FROM messages WHERE conversation_id = :conversationId AND client_msg_id = :clientMsgId', { conversationId, clientMsgId });
      return r ? toMessage(r) : null;
    },
    async findById(organizationId, id) {
      const [r] = await select('SELECT * FROM messages WHERE id = :id AND organization_id = :organizationId', { id, organizationId });
      return r ? toMessage(r) : null;
    },
    async findByIdForUpdate(organizationId, id) {
      const [r] = await select(`SELECT * FROM messages WHERE id = :id AND organization_id = :organizationId${lock('update')}`, { id, organizationId });
      return r ? toMessage(r) : null;
    },
    async update(m) {
      await write(
        `UPDATE messages SET body_doc = :bodyDoc, body_text = :bodyText, reply_count = :replyCount, last_reply_at = :lastReplyAt,
           reply_user_ids = :replyUserIds, edited_at = :editedAt, deleted_at = :deletedAt, deleted_by = :deletedBy
         WHERE id = :id AND organization_id = :organizationId`,
        { ...m, bodyDoc: m.bodyDoc === null ? null : JSON.stringify(m.bodyDoc), replyUserIds: JSON.stringify(m.replyUserIds) },
      );
    },
    async latestReplies(threadRootId, n) {
      const rows = await select('SELECT * FROM messages WHERE thread_root_id = :threadRootId ORDER BY thread_seq DESC LIMIT :n', { threadRootId, n });
      return rows.map(toMessage).reverse();
    },
    async listReplies(threadRootId, q) {
      const rows = await select(
        `SELECT * FROM messages WHERE thread_root_id = :threadRootId ${q.after !== undefined ? 'AND thread_seq > :after' : ''} ORDER BY thread_seq ASC LIMIT :limit`,
        { threadRootId, after: q.after ?? null, limit: q.limit },
      );
      return rows.map(toMessage);
    },
    async listRoots(conversationId, q: MessagePageQuery) {
      const where = ['conversation_id = :conversationId', 'seq IS NOT NULL'];
      if (q.before !== undefined) where.push('seq < :before');
      if (q.after !== undefined) where.push('seq > :after');
      // Con `after` se leen los siguientes en orden; si no, los últimos (desc) y se dan vuelta.
      const asc = q.after !== undefined && q.before === undefined;
      const rows = await select(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY seq ${asc ? 'ASC' : 'DESC'} LIMIT :limit`, {
        conversationId,
        before: q.before ?? null,
        after: q.after ?? null,
        limit: q.limit,
      });
      const list = rows.map(toMessage);
      return asc ? list : list.reverse();
    },
    async hasRootBefore(conversationId, seq) {
      const rows = await select('SELECT 1 FROM messages WHERE conversation_id = :conversationId AND seq IS NOT NULL AND seq < :seq LIMIT 1', { conversationId, seq });
      return rows.length > 0;
    },
    async hasRootAfter(conversationId, seq) {
      const rows = await select('SELECT 1 FROM messages WHERE conversation_id = :conversationId AND seq > :seq LIMIT 1', { conversationId, seq });
      return rows.length > 0;
    },
    async unreadCounts(userId, cursors) {
      const out = new Map<string, UnreadCounts>();
      if (!cursors.length) return out;
      // Una consulta por tipo de contador, con el cursor de cada conversación en una tabla derivada (sin N consultas).
      const pairs = cursors.map((_c, i) => `SELECT :c${i} AS conversation_id, :s${i} AS last_read_seq`).join(' UNION ALL ');
      const repl: Record<string, unknown> = { userId };
      cursors.forEach((c, i) => {
        repl[`c${i}`] = c.conversationId;
        repl[`s${i}`] = c.lastReadSeq;
      });
      const unread = await select(
        `SELECT m.conversation_id, COUNT(*) AS n FROM messages m JOIN (${pairs}) k ON k.conversation_id = m.conversation_id
          WHERE m.seq > k.last_read_seq AND m.kind = 'user' AND m.deleted_at IS NULL AND (m.sender_id IS NULL OR m.sender_id <> :userId)
          GROUP BY m.conversation_id`,
        repl,
      );
      const mentions = await select(
        `SELECT m.conversation_id, COUNT(*) AS n FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
           JOIN (${pairs}) k ON k.conversation_id = m.conversation_id
          WHERE mm.user_id = :userId AND m.seq > k.last_read_seq AND m.deleted_at IS NULL
          GROUP BY m.conversation_id`,
        repl,
      );
      for (const r of unread) out.set(String(r.conversation_id), { unread: num(r.n), mentions: 0 });
      for (const r of mentions) out.set(String(r.conversation_id), { unread: out.get(String(r.conversation_id))?.unread ?? 0, mentions: num(r.n) });
      return out;
    },
    async search(q) {
      const where = [
        'm.organization_id = :organizationId',
        'm.deleted_at IS NULL',
        "m.kind = 'user'",
        // Legible: canal público o conversación de la que es miembro (canRead). Un DM o un privado ajeno nunca, ni para chat:admin.
        "((c.kind = 'channel' AND c.visibility = 'public') OR EXISTS (SELECT 1 FROM conversation_members x WHERE x.conversation_id = c.id AND x.user_id = :userId))",
      ];
      const repl: Record<string, unknown> = { organizationId: q.organizationId, userId: q.userId, limit: q.limit };
      if (q.booleanQuery) {
        where.push('MATCH(m.body_text) AGAINST(:booleanQuery IN BOOLEAN MODE)');
        repl.booleanQuery = q.booleanQuery;
      }
      q.likeTerms.forEach((t, i) => {
        where.push(`m.body_text LIKE :like${i}`);
        // `%` y `_` escritos por la persona son literales, no comodines.
        repl[`like${i}`] = `%${t.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      });
      if (q.conversationId) {
        where.push('m.conversation_id = :conversationId');
        repl.conversationId = q.conversationId;
      }
      if (q.fromUserId) {
        where.push('m.sender_id = :fromUserId');
        repl.fromUserId = q.fromUserId;
      }
      if (q.before) {
        where.push('(m.created_at < :beforeAt OR (m.created_at = :beforeAt AND m.id < :beforeId))');
        repl.beforeAt = q.before.createdAt;
        repl.beforeId = q.before.id;
      }
      const rows = await select(
        `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT :limit`,
        repl,
      );
      return rows.map(toMessage);
    },
    async latestRoots(conversationIds) {
      const out = new Map<string, Message>();
      if (!conversationIds.length) return out;
      const rows = await select(
        `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id AND m.seq = c.message_seq
          WHERE m.conversation_id IN (:conversationIds)`,
        { conversationIds },
      );
      for (const r of rows) out.set(String(r.conversation_id), toMessage(r));
      return out;
    },
  };

  const mentions: MentionRepository = {
    async insertMany(list) {
      for (const m of list) {
        await write(
          `INSERT IGNORE INTO message_mentions (message_id, user_id, organization_id, conversation_id, kind)
           VALUES (:messageId, :userId, :organizationId, :conversationId, :kind)`,
          m as unknown as Record<string, unknown>,
        );
      }
    },
  };

  const reactions: ReactionRepository = {
    async add(r) {
      return (
        (await write(
          'INSERT IGNORE INTO message_reactions (message_id, user_id, emoji, organization_id, created_at) VALUES (:messageId, :userId, :emoji, :organizationId, :at)',
          r as unknown as Record<string, unknown>,
        )) > 0
      );
    },
    async remove(messageId, userId, emoji) {
      return (await write('DELETE FROM message_reactions WHERE message_id = :messageId AND user_id = :userId AND emoji = :emoji', { messageId, userId, emoji })) > 0;
    },
    async groupsFor(messageIds) {
      const out = new Map<string, ReactionGroup[]>();
      if (!messageIds.length) return out;
      const rows = await select(
        'SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN (:messageIds) ORDER BY created_at, user_id',
        { messageIds },
      );
      for (const r of rows) {
        const id = String(r.message_id);
        const groups = out.get(id) ?? [];
        const g = groups.find((x) => x.emoji === r.emoji);
        if (g) g.userIds.push(String(r.user_id));
        else groups.push({ emoji: String(r.emoji), userIds: [String(r.user_id)] });
        out.set(id, groups);
      }
      return out;
    },
  };

  const threadFollowers: ThreadFollowerRepository = {
    async add(threadRootId, userIds, organizationId) {
      for (const userId of new Set(userIds)) {
        await write('INSERT IGNORE INTO thread_followers (thread_root_id, user_id, organization_id) VALUES (:threadRootId, :userId, :organizationId)', {
          threadRootId,
          userId,
          organizationId,
        });
      }
    },
    async list(threadRootId) {
      return (await select('SELECT user_id FROM thread_followers WHERE thread_root_id = :threadRootId', { threadRootId })).map((r) => String(r.user_id));
    },
    async markRead(threadRootId, userId, threadSeq) {
      // GREATEST: un aviso viejo no hace retroceder el cursor. LEAST con la última respuesta: no se puede «leer» lo que no existe.
      await write(
        `UPDATE thread_followers SET last_read_thread_seq = GREATEST(last_read_thread_seq,
            LEAST(:threadSeq, (SELECT COALESCE(MAX(m.thread_seq), 0) FROM messages m WHERE m.thread_root_id = :threadRootId)))
          WHERE thread_root_id = :threadRootId AND user_id = :userId`,
        { threadRootId, userId, threadSeq },
      );
      const [r] = await select('SELECT last_read_thread_seq FROM thread_followers WHERE thread_root_id = :threadRootId AND user_id = :userId', { threadRootId, userId });
      return r ? num(r.last_read_thread_seq) : null;
    },
    async listForUser(q) {
      const where = ['f.user_id = :userId', 'f.organization_id = :organizationId', 'm.reply_count > 0', 'm.last_reply_at IS NOT NULL', READABLE];
      if (q.before) where.push('(m.last_reply_at < :beforeAt OR (m.last_reply_at = :beforeAt AND m.id < :beforeId))');
      const rows = await select(
        `SELECT m.*, f.last_read_thread_seq AS f_cursor FROM thread_followers f
           JOIN messages m ON m.id = f.thread_root_id JOIN conversations c ON c.id = m.conversation_id
          WHERE ${where.join(' AND ')} ORDER BY m.last_reply_at DESC, m.id DESC LIMIT :limit`,
        { userId: q.userId, organizationId: q.organizationId, beforeAt: q.before?.lastReplyAt ?? null, beforeId: q.before?.id ?? null, limit: q.limit },
      );
      return rows.map((r) => ({ root: toMessage(r), lastReadThreadSeq: num(r.f_cursor) }));
    },
    async counts(userId, items) {
      const out = new Map<string, UnreadCounts>();
      if (!items.length) return out;
      // Igual que `unreadCounts`: los cursores en una tabla derivada, una consulta por contador (sin N consultas).
      const pairs = items.map((_x, i) => `SELECT :r${i} AS root_id, :s${i} AS cursor_seq`).join(' UNION ALL ');
      const repl: Record<string, unknown> = { userId };
      items.forEach((x, i) => {
        repl[`r${i}`] = x.threadRootId;
        repl[`s${i}`] = x.lastReadThreadSeq;
      });
      const unread = await select(
        `SELECT r.thread_root_id, COUNT(*) AS n FROM messages r JOIN (${pairs}) k ON k.root_id = r.thread_root_id
          WHERE r.thread_seq > k.cursor_seq AND r.kind = 'user' AND r.deleted_at IS NULL AND (r.sender_id IS NULL OR r.sender_id <> :userId)
          GROUP BY r.thread_root_id`,
        repl,
      );
      const mentions = await select(
        `SELECT r.thread_root_id, COUNT(*) AS n FROM message_mentions mm JOIN messages r ON r.id = mm.message_id JOIN (${pairs}) k ON k.root_id = r.thread_root_id
          WHERE mm.user_id = :userId AND r.thread_seq > k.cursor_seq AND r.deleted_at IS NULL
          GROUP BY r.thread_root_id`,
        repl,
      );
      for (const r of unread) out.set(String(r.thread_root_id), { unread: num(r.n), mentions: 0 });
      for (const r of mentions) out.set(String(r.thread_root_id), { unread: out.get(String(r.thread_root_id))?.unread ?? 0, mentions: num(r.n) });
      return out;
    },
    async totals(organizationId, userId) {
      const base = `FROM thread_followers f JOIN messages m ON m.id = f.thread_root_id JOIN conversations c ON c.id = m.conversation_id
        JOIN messages r ON r.thread_root_id = f.thread_root_id AND r.thread_seq > f.last_read_thread_seq AND r.deleted_at IS NULL`;
      const [threads] = await select(
        `SELECT COUNT(DISTINCT f.thread_root_id) AS n ${base}
          WHERE f.user_id = :userId AND f.organization_id = :organizationId AND ${READABLE}
            AND r.kind = 'user' AND (r.sender_id IS NULL OR r.sender_id <> :userId)
            AND NOT EXISTS (SELECT 1 FROM conversation_members s WHERE s.conversation_id = c.id AND s.user_id = :userId AND s.muted = 1)`,
        { organizationId, userId },
      );
      const [mentions] = await select(
        `SELECT COUNT(*) AS n ${base} JOIN message_mentions mm ON mm.message_id = r.id AND mm.user_id = :userId
          WHERE f.user_id = :userId AND f.organization_id = :organizationId AND ${READABLE}`,
        { organizationId, userId },
      );
      return { threads: num(threads?.n), mentions: num(mentions?.n) };
    },
  };

  const inactiveUsers: InactiveUserRepository = {
    async mark(organizationId, userId, since) {
      await write('INSERT IGNORE INTO inactive_users (organization_id, user_id, since) VALUES (:organizationId, :userId, :since)', { organizationId, userId, since });
    },
    async clear(organizationId, userId) {
      await write('DELETE FROM inactive_users WHERE organization_id = :organizationId AND user_id = :userId', { organizationId, userId });
    },
    async inactiveAmong(organizationId, userIds) {
      if (!userIds.length) return new Set();
      const rows = await select('SELECT user_id FROM inactive_users WHERE organization_id = :organizationId AND user_id IN (:userIds)', { organizationId, userIds });
      return new Set(rows.map((r) => String(r.user_id)));
    },
  };

  const outbox: OutboxRepository = {
    async add(event: DomainEvent) {
      await write(
        `INSERT INTO outbox_messages (id, aggregate_type, aggregate_id, type, payload, occurred_at, processed_at)
         VALUES (:id, :aggregateType, :aggregateId, :type, :payload, :occurredAt, NULL)`,
        {
          id: event.eventId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          type: event.type,
          // Actor, IP y request-id viajan en el contexto de la petición (runWithActor del middleware).
          payload: JSON.stringify(withActor(event.payload)),
          occurredAt: event.occurredAt,
        },
      );
    },
  };

  const toEmoji = (r: Row): CustomEmoji => ({
    id: String(r.id),
    organizationId: String(r.organization_id),
    name: String(r.name),
    documentId: String(r.document_id),
    createdBy: String(r.created_by),
    createdAt: new Date(r.created_at as string),
  });
  const emojis: EmojiRepository = {
    async list(organizationId) {
      return (await select('SELECT * FROM custom_emojis WHERE organization_id = :organizationId ORDER BY name', { organizationId })).map(toEmoji);
    },
    async findByName(organizationId, name) {
      const [r] = await select('SELECT * FROM custom_emojis WHERE organization_id = :organizationId AND name = :name', { organizationId, name });
      return r ? toEmoji(r) : null;
    },
    async findById(organizationId, id) {
      const [r] = await select('SELECT * FROM custom_emojis WHERE organization_id = :organizationId AND id = :id', { organizationId, id });
      return r ? toEmoji(r) : null;
    },
    async insertIfAbsent(e) {
      const affected = await write(
        'INSERT IGNORE INTO custom_emojis (id, organization_id, name, document_id, created_by, created_at) VALUES (:id, :organizationId, :name, :documentId, :createdBy, :createdAt)',
        { ...e },
      );
      return affected > 0;
    },
    async remove(organizationId, id) {
      return (await write('DELETE FROM custom_emojis WHERE organization_id = :organizationId AND id = :id', { organizationId, id })) > 0;
    },
  };

  return { conversations, members, messages, mentions, reactions, threadFollowers, inactiveUsers, emojis, outbox };
}

/** Lecturas fuera de transacción. */
export const readOnlyRepositories: Repositories = buildRepositories();

class SequelizeUnitOfWork implements WriteUnitOfWork {
  readonly conversations;
  readonly members;
  readonly messages;
  readonly mentions;
  readonly reactions;
  readonly threadFollowers;
  readonly inactiveUsers;
  readonly emojis;
  readonly outbox;

  constructor(private readonly tx: Transaction) {
    const repos = buildRepositories(tx);
    this.conversations = repos.conversations;
    this.members = repos.members;
    this.messages = repos.messages;
    this.mentions = repos.mentions;
    this.reactions = repos.reactions;
    this.threadFollowers = repos.threadFollowers;
    this.inactiveUsers = repos.inactiveUsers;
    this.emojis = repos.emojis;
    this.outbox = repos.outbox;
  }

  async commit(): Promise<void> {
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    // Tras un deadlock MySQL ya deshizo la transacción y Sequelize la da por terminada: un segundo rollback taparía el error real.
    if ((this.tx as unknown as { finished?: string }).finished) return;
    await this.tx.rollback();
  }
}

export class SequelizeUnitOfWorkFactory implements UnitOfWorkGateway {
  constructor(private readonly onBegin?: (tx: Transaction) => void) {}

  isRetryable(err: unknown): boolean {
    const e = err as { parent?: { code?: string; errno?: number }; original?: { code?: string; errno?: number } };
    const cause = e?.parent ?? e?.original;
    return cause?.code === 'ER_LOCK_DEADLOCK' || cause?.errno === 1213;
  }

  async begin(): Promise<WriteUnitOfWork> {
    const tx = await sequelize.transaction();
    // El relay publica el outbox justo tras el commit; sin este enganche los eventos esperan el barrido de respaldo.
    this.onBegin?.(tx);
    return new SequelizeUnitOfWork(tx);
  }
}
