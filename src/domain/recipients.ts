import type { Conversation, Member, MentionKind } from './types.js';

/**
 * A quién avisar de un mensaje nuevo (tabla «Avisos» de IMPLEMENTATION.md). Puro: recibe los miembros y las menciones ya validadas.
 *
 * - `memberUserIds`: todos los miembros salvo el autor → el hub les reenvía el mensaje por socket (contadores y lista).
 * - `notifyUserIds`: notificación del navegador.
 * - `userIds`: campana del CRM (menciones directas, @canal y DMs; nunca un mensaje normal de canal).
 * - `hereUserIds`: mencionados por @aquí; el hub solo avisa a los que están conectados.
 * - `mentions`: filas de `message_mentions` (contador de menciones), una por persona.
 *
 * Silenciar (`muted`) apaga todo salvo la mención directa. `notify = none` apaga navegador y campana salvo la mención directa (como Slack:
 * una mención directa siempre llega). Nunca se avisa al autor.
 */
export interface MessageRecipients {
  memberUserIds: string[];
  notifyUserIds: string[];
  userIds: string[];
  hereUserIds: string[];
  mentions: Array<{ userId: string; kind: MentionKind }>;
}

export interface RecipientInput {
  conversation: Conversation;
  members: Member[];
  senderId: string;
  /** @persona ya filtradas a miembros de la conversación. */
  mentionedUserIds: string[];
  mentionsChannel: boolean;
  mentionsHere: boolean;
  /**
   * Respuesta de hilo (con sus seguidores). Una respuesta NO es un mensaje del canal: no avisa por «todo» ni cuenta como no leído del
   * canal (no tiene `seq`). Avisa a quien sigue el hilo y a los mencionados; en un DM, además, campana a los seguidores.
   */
  threadFollowerIds?: string[];
}

export function computeRecipients(input: RecipientInput): MessageRecipients {
  const { conversation, senderId } = input;
  const isDm = conversation.kind !== 'channel';
  const direct = new Set(input.mentionedUserIds);
  const isReply = input.threadFollowerIds !== undefined;
  const followers = new Set(input.threadFollowerIds ?? []);
  const out: MessageRecipients = { memberUserIds: [], notifyUserIds: [], userIds: [], hereUserIds: [], mentions: [] };

  for (const m of input.members) {
    if (m.userId === senderId) continue;
    out.memberUserIds.push(m.userId);
    const mentioned = direct.has(m.userId);
    if (mentioned) out.mentions.push({ userId: m.userId, kind: 'user' });
    else if (input.mentionsChannel) out.mentions.push({ userId: m.userId, kind: 'channel' });
    else if (input.mentionsHere) out.mentions.push({ userId: m.userId, kind: 'here' });

    if (mentioned) {
      out.notifyUserIds.push(m.userId);
      out.userIds.push(m.userId);
      continue;
    }
    if (m.muted || m.notify === 'none') continue;

    if (input.mentionsHere && !input.mentionsChannel) out.hereUserIds.push(m.userId);
    if (isReply) {
      const follows = followers.has(m.userId);
      if (follows || input.mentionsChannel) out.notifyUserIds.push(m.userId);
      if ((isDm && follows) || input.mentionsChannel) out.userIds.push(m.userId);
      continue;
    }
    const bell = isDm || input.mentionsChannel;
    const browser = bell || m.notify === 'all';
    if (browser) out.notifyUserIds.push(m.userId);
    if (bell) out.userIds.push(m.userId);
  }
  return out;
}
