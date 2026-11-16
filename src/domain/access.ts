import { BROADCAST_FREE_MAX_MEMBERS, CHAT_ADMIN, type Actor, type Conversation, type Member, type Message } from './types.js';

/**
 * Reglas de acceso (tabla de IMPLEMENTATION.md → «Reglas de acceso»). Funciones puras: el caso de uso trae la conversación y la fila
 * de miembro de quien actúa y pregunta aquí. Quien no puede LEER recibe 404 (lo decide el caso de uso con `canRead`); quien lee pero no
 * puede hacer algo concreto, 403.
 *
 * `chat:admin` gestiona canales y borra mensajes ajenos, pero NO abre DMs ni canales privados de los que no es miembro (decisión del
 * dueño: «privado, sin exportar»).
 */
export const isAdmin = (actor: Actor) => actor.permissions.includes(CHAT_ADMIN) || actor.permissions.includes('*');

const isChannel = (c: Conversation) => c.kind === 'channel';
const isPublic = (c: Conversation) => c.kind === 'channel' && c.visibility === 'public';

/** Leer mensajes: un canal público, cualquiera de la organización; lo demás, solo sus miembros. */
export function canRead(c: Conversation, me: Member | null): boolean {
  return isPublic(c) || me !== null;
}

/** Escribir y reaccionar: miembro (en un canal público, escribir une primero — lo hace el caso de uso). Archivado: nadie. */
export function canWrite(c: Conversation, me: Member | null): boolean {
  return c.archivedAt === null && me !== null;
}

/** Renombrar, tema, descripción, archivar y quitar a otros: el dueño del canal o `chat:admin` (en privados, solo si es miembro). */
export function canManage(actor: Actor, c: Conversation, me: Member | null): boolean {
  if (!isChannel(c)) return false;
  if (me?.role === 'owner') return true;
  if (!isAdmin(actor)) return false;
  return isPublic(c) || me !== null;
}

/** Agregar personas a un canal: cualquier miembro. A un DM no se agrega gente (en Slack se abre otro DM de grupo). */
export function canAddMembers(c: Conversation, me: Member | null): boolean {
  return isChannel(c) && c.archivedAt === null && me !== null;
}

/** Editar: solo su autor, y no un mensaje de sistema ni uno borrado. */
export function canEdit(actor: Actor, m: Message): boolean {
  return m.kind === 'user' && m.deletedAt === null && m.senderId === actor.userId;
}

/** Borrar: su autor; en un canal, también `chat:admin` (si puede leerlo). En un DM, nadie más que el autor (decisión «privado»). */
export function canDelete(actor: Actor, c: Conversation, m: Message): boolean {
  if (m.kind !== 'user' || m.deletedAt !== null) return false;
  if (m.senderId === actor.userId) return true;
  return c.kind === 'channel' && isAdmin(actor);
}

/** @canal / @aquí: libres en canales pequeños; en los grandes, el dueño o `chat:admin`. En DMs avisan igual que un mensaje normal. */
export function canBroadcast(actor: Actor, c: Conversation, me: Member | null, memberCount: number): boolean {
  if (!isChannel(c)) return true;
  if (memberCount <= BROADCAST_FREE_MAX_MEMBERS) return true;
  return me?.role === 'owner' || isAdmin(actor);
}
