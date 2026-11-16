import type { ChannelListing, ReactionGroup } from '../../domain/repositories.js';
import type { ConversationView, Member, Message } from '../../domain/types.js';
import type { ConversationDetail, InboxSummary } from '../../application/use-cases/conversation-use-cases.js';

/** Respuestas HTTP (forma de `openapi.yaml`). Fechas en ISO; nada interno (`name_key`, `dm_key`) sale al cliente. */
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function membershipDto(m: Member) {
  return { role: m.role, notify: m.notify, muted: m.muted, lastReadSeq: m.lastReadSeq, joinedAt: iso(m.joinedAt) };
}

export function conversationSummaryDto(v: ConversationView) {
  const c = v.conversation;
  return {
    id: c.id,
    kind: c.kind,
    visibility: c.visibility,
    name: c.name,
    isGeneral: c.isGeneral,
    participantUserIds: c.kind === 'channel' ? [] : v.participantUserIds,
    archivedAt: iso(c.archivedAt),
    lastMessageAt: iso(c.lastMessageAt),
    lastMessageSeq: c.messageSeq,
    unreadCount: v.unreadCount,
    mentionCount: v.mentionCount,
    me: v.me ? membershipDto(v.me) : null,
  };
}

export function conversationDetailDto(d: ConversationDetail) {
  const c = d.conversation;
  return {
    ...conversationSummaryDto(d),
    topic: c.topic,
    description: c.description,
    createdBy: c.createdBy,
    createdAt: iso(c.createdAt),
    memberCount: d.memberCount,
    isMember: d.isMember,
  };
}

export function channelListingDto(l: ChannelListing) {
  const c = l.conversation;
  return { id: c.id, name: c.name, visibility: c.visibility, topic: c.topic, memberCount: l.memberCount, isMember: l.isMember, archivedAt: iso(c.archivedAt) };
}

export function memberDto(m: Member & { inactive: boolean }) {
  return { userId: m.userId, role: m.role, joinedAt: iso(m.joinedAt), inactive: m.inactive };
}

/** Un mensaje. `viewerId` decide `mentionsMe` y qué reacción es «mía». */
export function messageDto(m: Message, viewerId?: string, reactions: ReactionGroup[] = []) {
  const deleted = m.deletedAt !== null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq: m.seq,
    threadRootId: m.threadRootId,
    threadSeq: m.threadSeq,
    senderId: m.senderId,
    kind: m.kind,
    bodyDoc: deleted ? null : m.bodyDoc,
    bodyText: deleted ? null : m.bodyText,
    clientMsgId: m.clientMsgId,
    replyCount: m.replyCount,
    lastReplyAt: iso(m.lastReplyAt),
    replyUserIds: m.replyUserIds,
    reactions: deleted ? [] : reactions.map((g) => ({ emoji: g.emoji, count: g.userIds.length, userIds: g.userIds, mine: !!viewerId && g.userIds.includes(viewerId) })),
    mentionsMe: viewerId ? mentionsUser(m, viewerId) : false,
    editedAt: iso(m.editedAt),
    deletedAt: iso(m.deletedAt),
    createdAt: iso(m.createdAt),
  };
}

/** ¿El documento menciona a esta persona (o a todo el canal)? Se lee del documento para no hacer otra consulta por mensaje. */
function mentionsUser(m: Message, userId: string): boolean {
  if (!m.bodyDoc || m.senderId === userId) return false;
  const stack: unknown[] = [m.bodyDoc];
  while (stack.length) {
    const node = stack.pop() as { type?: unknown; attrs?: { id?: unknown }; content?: unknown };
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'mention' && (node.attrs?.id === userId || node.attrs?.id === 'channel' || node.attrs?.id === 'here')) return true;
    if (Array.isArray(node.content)) stack.push(...node.content);
  }
  return false;
}

export function inboxDto(s: InboxSummary, viewerId: string) {
  return {
    conversations: s.conversations,
    mentions: s.mentions,
    threads: s.threads,
    latest: s.latest.map(({ view, lastMessage }) => ({
      conversationId: view.conversation.id,
      kind: view.conversation.kind,
      name: view.conversation.name,
      participantUserIds: view.conversation.kind === 'channel' ? [] : view.participantUserIds,
      unreadCount: view.unreadCount,
      mentionCount: view.mentionCount,
      lastMessage: messageDto(lastMessage, viewerId),
    })),
  };
}
