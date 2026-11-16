/**
 * Tipos del dominio de la mensajería (modelo Slack). Ver IMPLEMENTATION.md → «Modelo de datos» y «Reglas de acceso».
 *
 * Personas y organización son ids de auth-service: aquí no se guardan nombres, fotos ni correos (el frontend los toma del directorio).
 */

export type ConversationKind = 'channel' | 'dm' | 'group_dm';
export type Visibility = 'public' | 'private';
export type MemberRole = 'owner' | 'member';
export type NotifyLevel = 'all' | 'mentions' | 'none';
export type MessageKind = 'user' | 'system';
export type MentionKind = 'user' | 'channel' | 'here';

export const CONVERSATION_KINDS: readonly ConversationKind[] = ['channel', 'dm', 'group_dm'];
export const VISIBILITIES: readonly Visibility[] = ['public', 'private'];
export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['all', 'mentions', 'none'];

/** Documento de TipTap ya validado por `richtext.ts`. */
export type RichDoc = Record<string, unknown>;

/** Quien hace la petición: lo inyecta el gateway (`X-User-Id`, `X-Organization-Id`, `X-Permissions`). */
export interface Actor {
  userId: string;
  organizationId: string;
  permissions: string[];
}

export interface Conversation {
  id: string;
  organizationId: string;
  kind: ConversationKind;
  /** Solo canales. */
  visibility: Visibility | null;
  /** Solo canales: el nombre tal como se escribió. */
  name: string | null;
  /** Solo canales: minúsculas y sin tildes; único por organización (`UNIQUE (organization_id, name_key)`). */
  nameKey: string | null;
  topic: string | null;
  description: string | null;
  isGeneral: boolean;
  /** Solo DMs: hash de los participantes ordenados; único por organización (abrir el mismo DM dos veces da la misma conversación). */
  dmKey: string | null;
  createdBy: string;
  archivedAt: Date | null;
  /** Último `seq` asignado a un mensaje raíz. Se incrementa bajo bloqueo de la fila. */
  messageSeq: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Member {
  conversationId: string;
  userId: string;
  organizationId: string;
  role: MemberRole;
  notify: NotifyLevel;
  muted: boolean;
  /** Hasta qué `seq` leyó (línea de «nuevos»). Solo avanza. */
  lastReadSeq: number;
  joinedAt: Date;
}

export interface Message {
  id: string;
  organizationId: string;
  conversationId: string;
  /** Mensaje raíz: 1, 2, 3… por conversación. Null en respuestas de hilo. */
  seq: number | null;
  threadRootId: string | null;
  /** Respuesta de hilo: 1, 2, 3… dentro de su raíz. */
  threadSeq: number | null;
  /** Null en mensajes de sistema. */
  senderId: string | null;
  kind: MessageKind;
  /** Null si se borró. */
  bodyDoc: RichDoc | null;
  bodyText: string | null;
  clientMsgId: string | null;
  replyCount: number;
  lastReplyAt: Date | null;
  replyUserIds: string[];
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  createdAt: Date;
}

export interface Mention {
  messageId: string;
  userId: string;
  organizationId: string;
  conversationId: string;
  kind: MentionKind;
}

/** Una conversación vista desde una persona: su fila de miembro (si la tiene) y sus contadores. */
export interface CustomEmoji {
  id: string;
  organizationId: string;
  name: string;
  /** Imagen en document-service (`resourceType: chat_emoji`). */
  documentId: string;
  createdBy: string;
  createdAt: Date;
}

export interface ConversationView {
  conversation: Conversation;
  me: Member | null;
  participantUserIds: string[];
  unreadCount: number;
  mentionCount: number;
}

/** Tope de los contadores: la barra muestra «99+». */
export const UNREAD_CAP = 99;
/** Texto de un mensaje (decisión: el editor de Proyectos con un tope más bajo). */
export const MAX_MESSAGE_CHARS = 4000;
/** `@canal` / `@aquí` libres hasta este tamaño; en canales más grandes, solo el dueño o `chat:admin`. */
export const BROADCAST_FREE_MAX_MEMBERS = 20;
/** DM de grupo: 2 a 8 personas además de quien lo abre (como Slack). */
export const GROUP_DM_MIN = 2;
export const GROUP_DM_MAX = 8;
export const CHAT_ADMIN = 'chat:admin';
