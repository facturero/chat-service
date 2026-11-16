import type { Conversation, CustomEmoji, Member, Mention, Message, NotifyLevel } from './types.js';

/**
 * Puertos de persistencia. La implementación de MySQL está en `infrastructure/persistence/repositories.ts` y la de memoria (pruebas) en
 * `__tests__/helpers.ts`; las dos deben tener la MISMA semántica (filtro por organización, «insertar si no existe», orden por `seq`).
 */

export interface DomainEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface ChannelListing {
  conversation: Conversation;
  memberCount: number;
  isMember: boolean;
}

export interface UnreadCounts {
  unread: number;
  mentions: number;
}

export interface ReactionGroup {
  emoji: string;
  userIds: string[];
}

export interface MessagePageQuery {
  before?: number;
  after?: number;
  limit: number;
}

/** Búsqueda (ver `domain/search.ts`): legibles para `userId`, más recientes primero. */
export interface MessageSearchQuery {
  organizationId: string;
  userId: string;
  /** Para `MATCH … AGAINST` en modo booleano; null = solo `likeTerms`. */
  booleanQuery: string | null;
  likeTerms: string[];
  conversationId?: string;
  fromUserId?: string;
  before?: { createdAt: Date; id: string };
  limit: number;
}

export interface ConversationRepository {
  findById(organizationId: string, id: string): Promise<Conversation | null>;
  /** Con bloqueo de escritura de la fila: el `seq` del mensaje siguiente se decide aquí, uno a la vez. */
  findByIdForUpdate(organizationId: string, id: string): Promise<Conversation | null>;
  findGeneral(organizationId: string): Promise<Conversation | null>;
  findByNameKey(organizationId: string, nameKey: string): Promise<Conversation | null>;
  /** Con bloqueo compartido: tras un «insertar si no existe» que perdió la carrera, lee la que ganó. */
  findByDmKey(organizationId: string, dmKey: string): Promise<Conversation | null>;
  /** INSERT IGNORE: false si chocó con un UNIQUE (nombre o dm_key) — otra petición la creó primero. */
  insertIfAbsent(c: Conversation): Promise<boolean>;
  update(c: Conversation): Promise<void>;
  /** Las conversaciones de las que la persona es miembro. */
  listForMember(organizationId: string, userId: string, includeArchived: boolean): Promise<Array<{ conversation: Conversation; me: Member }>>;
  /** Canales públicos de la organización y los privados donde ya es miembro. */
  browseChannels(organizationId: string, userId: string, q: string | null, includeArchived: boolean): Promise<ChannelListing[]>;
}

export interface MemberRepository {
  find(conversationId: string, userId: string): Promise<Member | null>;
  /** INSERT IGNORE: false si ya era miembro. */
  insertIfAbsent(m: Member): Promise<boolean>;
  remove(conversationId: string, userId: string): Promise<boolean>;
  list(conversationId: string): Promise<Member[]>;
  /** Ids de los miembros de varias conversaciones (participantes de los DMs en la barra lateral). */
  userIdsByConversation(conversationIds: string[]): Promise<Map<string, string[]>>;
  count(conversationId: string): Promise<number>;
  /** Solo avanza: `GREATEST(last_read_seq, :seq)`. Devuelve el cursor resultante. */
  advanceRead(conversationId: string, userId: string, seq: number): Promise<number>;
  updatePreferences(conversationId: string, userId: string, prefs: { notify?: NotifyLevel; muted?: boolean }): Promise<void>;
  /** Canales (no DMs) donde está la persona en la organización: para sacarla al desactivarla. */
  channelIdsOf(organizationId: string, userId: string): Promise<string[]>;
}

export interface MessageRepository {
  /** INSERT IGNORE por `(conversation_id, client_msg_id)`: false si ese envío ya se había guardado (reintento del navegador). */
  insertIfAbsent(m: Message): Promise<boolean>;
  findByClientMsgId(conversationId: string, clientMsgId: string): Promise<Message | null>;
  findById(organizationId: string, id: string): Promise<Message | null>;
  /** Con bloqueo de escritura: la raíz de un hilo, para decidir el `thread_seq` siguiente y su contador, uno a la vez. */
  findByIdForUpdate(organizationId: string, id: string): Promise<Message | null>;
  /** Guarda texto, edición, borrado y contadores del hilo de un mensaje existente. */
  update(m: Message): Promise<void>;
  /** Las últimas `n` respuestas de un hilo, ascendentes (la vista «Hilos» muestra las más recientes debajo de la raíz). */
  latestReplies(threadRootId: string, n: number): Promise<Message[]>;
  /** Respuestas de un hilo, ascendentes por `thread_seq`. */
  listReplies(threadRootId: string, q: { after?: number; limit: number }): Promise<Message[]>;
  /** Mensajes raíz, ascendentes por `seq`. Sin cursores: los últimos `limit`. */
  listRoots(conversationId: string, q: MessagePageQuery): Promise<Message[]>;
  /** Hay mensajes raíz antes / después de estos `seq`. */
  hasRootBefore(conversationId: string, seq: number): Promise<boolean>;
  hasRootAfter(conversationId: string, seq: number): Promise<boolean>;
  /** No leídos (raíz, de otros, sin borrar, sin sistema) y menciones sin leer, por conversación, para una persona. */
  unreadCounts(userId: string, cursors: Array<{ conversationId: string; lastReadSeq: number }>): Promise<Map<string, UnreadCounts>>;
  /** El último mensaje raíz de cada conversación (bandeja de la barra superior). */
  latestRoots(conversationIds: string[]): Promise<Map<string, Message>>;
  search(q: MessageSearchQuery): Promise<Message[]>;
}

export interface MentionRepository {
  insertMany(mentions: Mention[]): Promise<void>;
}

export interface ReactionRepository {
  /** INSERT IGNORE por `(message_id, user_id, emoji)`: false si ya estaba. */
  add(r: { messageId: string; userId: string; emoji: string; organizationId: string; at: Date }): Promise<boolean>;
  remove(messageId: string, userId: string, emoji: string): Promise<boolean>;
  /** Reacciones de varios mensajes, agrupadas por emoji en el orden en que aparecieron. */
  groupsFor(messageIds: string[]): Promise<Map<string, ReactionGroup[]>>;
}

export interface ThreadFollowerRepository {
  /** INSERT IGNORE: seguir un hilo dos veces es lo mismo. */
  add(threadRootId: string, userIds: string[], organizationId: string): Promise<void>;
  list(threadRootId: string): Promise<string[]>;
  /**
   * Avanza el cursor de leído de un seguidor (nunca retrocede ni pasa de la última respuesta). Si no sigue el hilo, no hace nada y
   * devuelve null; si no, el cursor que quedó.
   */
  markRead(threadRootId: string, userId: string, threadSeq: number): Promise<number | null>;
  /** Hilos que sigue la persona, con respuestas y que todavía puede leer; el de respuesta más reciente primero. */
  listForUser(q: ThreadListQuery): Promise<Array<{ root: Message; lastReadThreadSeq: number }>>;
  /** Por hilo: respuestas de otros sin borrar tras el cursor, y menciones a la persona tras el cursor. */
  counts(userId: string, items: Array<{ threadRootId: string; lastReadThreadSeq: number }>): Promise<Map<string, UnreadCounts>>;
  /** Para el sobre y el menú: hilos con algo nuevo (sin contar conversaciones silenciadas) y menciones en hilos (siempre). */
  totals(organizationId: string, userId: string): Promise<{ threads: number; mentions: number }>;
}

export interface ThreadListQuery {
  organizationId: string;
  userId: string;
  before?: { lastReplyAt: Date; id: string };
  limit: number;
}

export interface InactiveUserRepository {
  mark(organizationId: string, userId: string, since: Date): Promise<void>;
  clear(organizationId: string, userId: string): Promise<void>;
  /** De estos ids, cuáles están inactivos. */
  inactiveAmong(organizationId: string, userIds: string[]): Promise<Set<string>>;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

export interface EmojiRepository {
  list(organizationId: string): Promise<CustomEmoji[]>;
  findByName(organizationId: string, name: string): Promise<CustomEmoji | null>;
  findById(organizationId: string, id: string): Promise<CustomEmoji | null>;
  /** INSERT IGNORE por `(organization_id, name)`: false si ese nombre ya estaba. */
  insertIfAbsent(e: CustomEmoji): Promise<boolean>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

export interface Repositories {
  conversations: ConversationRepository;
  members: MemberRepository;
  messages: MessageRepository;
  mentions: MentionRepository;
  reactions: ReactionRepository;
  threadFollowers: ThreadFollowerRepository;
  inactiveUsers: InactiveUserRepository;
  emojis: EmojiRepository;
  outbox: OutboxRepository;
}
