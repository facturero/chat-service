import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../domain/repositories.js';
import type { MessageRecipients } from '../domain/recipients.js';
import type { Conversation, Message } from '../domain/types.js';

/**
 * Eventos de la mensajería (contrato: `asyncapi.yaml`). Cada payload se arma A MANO, nunca con la entidad entera.
 *
 * REGLA 10 de IMPLEMENTATION.md: NINGÚN evento lleva el texto de un mensaje ni su documento. InboxConsumer guarda el payload de cada
 * evento en `processed_events` del consumidor (y audit-log consume `#`): el texto quedaría copiado en otras bases. El hub del gateway
 * pide el mensaje a `GET /internal/messages/:id`. `conversation-events.test.ts` lo vigila.
 */
function domainEvent(params: { type: string; aggregateType: string; aggregateId: string; organizationId: string; payload: Record<string, unknown> }): DomainEvent {
  return {
    eventId: randomUUID(),
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    type: params.type,
    payload: { ...params.payload, organizationId: params.organizationId },
    occurredAt: new Date(),
  };
}

function conversationBase(c: Conversation, memberUserIds: string[]): Record<string, unknown> {
  return {
    conversationId: c.id,
    kind: c.kind,
    visibility: c.visibility,
    name: c.name,
    // Canal público: el hub avisa a la organización entera con un aviso mínimo; no hace falta la lista.
    memberUserIds: c.kind === 'channel' && c.visibility === 'public' ? [] : memberUserIds,
  };
}

const conversationEvent = (type: string, c: Conversation, memberUserIds: string[], extra: Record<string, unknown> = {}) =>
  domainEvent({ type, aggregateType: 'conversation', aggregateId: c.id, organizationId: c.organizationId, payload: { ...conversationBase(c, memberUserIds), ...extra } });

export const conversationCreatedEvent = (c: Conversation, memberUserIds: string[]) =>
  conversationEvent('chat.conversation.created', c, memberUserIds, { createdBy: c.createdBy, isGeneral: c.isGeneral });

export const conversationUpdatedEvent = (c: Conversation, memberUserIds: string[], changes: string[]) =>
  conversationEvent('chat.conversation.updated', c, memberUserIds, { changes });

export const conversationArchivedEvent = (c: Conversation, memberUserIds: string[]) => conversationEvent('chat.conversation.archived', c, memberUserIds);
export const conversationUnarchivedEvent = (c: Conversation, memberUserIds: string[]) => conversationEvent('chat.conversation.unarchived', c, memberUserIds);

export const conversationReadEvent = (c: Conversation, userId: string, lastReadSeq: number) =>
  domainEvent({ type: 'chat.conversation.read', aggregateType: 'conversation', aggregateId: c.id, organizationId: c.organizationId, payload: { conversationId: c.id, userId, lastReadSeq } });

function memberEvent(type: string, c: Conversation, userIds: string[], memberUserIds: string[], reason: string): DomainEvent {
  return domainEvent({
    type,
    aggregateType: 'conversation',
    aggregateId: c.id,
    organizationId: c.organizationId,
    payload: { conversationId: c.id, kind: c.kind, visibility: c.visibility, userIds, memberUserIds, reason },
  });
}

export const memberJoinedEvent = (c: Conversation, userIds: string[], memberUserIds: string[], reason: 'joined' | 'added' | 'onboarding') =>
  memberEvent('chat.member.joined', c, userIds, memberUserIds, reason);

export const memberLeftEvent = (c: Conversation, userIds: string[], memberUserIds: string[], reason: 'left' | 'removed' | 'deactivated') =>
  memberEvent('chat.member.left', c, userIds, memberUserIds, reason);

/** Referencia al mensaje SIN texto ni documento. */
function messageRef(m: Message, mentionUserIds: string[]): Record<string, unknown> {
  return {
    messageId: m.id,
    seq: m.seq,
    threadRootId: m.threadRootId,
    threadSeq: m.threadSeq,
    senderId: m.senderId,
    messageKind: m.kind,
    mentionUserIds,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Edición o borrado: van a todos los miembros (no avisan). Sin texto: el hub vuelve a pedir el mensaje si hace falta. */
export function messageUpdatedEvent(c: Conversation, m: Message, memberUserIds: string[]): DomainEvent {
  return domainEvent({
    type: 'chat.message.updated',
    aggregateType: 'message',
    aggregateId: m.id,
    organizationId: c.organizationId,
    payload: { conversationId: c.id, ...messageRef(m, []), memberUserIds },
  });
}

export function messageDeletedEvent(c: Conversation, m: Message, memberUserIds: string[], byAdmin: boolean): DomainEvent {
  return domainEvent({
    type: 'chat.message.deleted',
    aggregateType: 'message',
    aggregateId: m.id,
    organizationId: c.organizationId,
    payload: { conversationId: c.id, messageId: m.id, threadRootId: m.threadRootId, deletedBy: m.deletedBy, byAdmin, memberUserIds },
  });
}

export function reactionEvent(added: boolean, c: Conversation, m: Message, emoji: string, userId: string, memberUserIds: string[]): DomainEvent {
  return domainEvent({
    type: added ? 'chat.reaction.added' : 'chat.reaction.removed',
    aggregateType: 'message',
    aggregateId: m.id,
    organizationId: c.organizationId,
    payload: { conversationId: c.id, messageId: m.id, threadRootId: m.threadRootId, emoji, userId, memberUserIds: memberUserIds.filter((u) => u !== userId) },
  });
}

export function messageCreatedEvent(c: Conversation, m: Message, r: MessageRecipients, mentionUserIds: string[]): DomainEvent {
  return domainEvent({
    type: 'chat.message.created',
    aggregateType: 'message',
    aggregateId: m.id,
    organizationId: c.organizationId,
    payload: {
      conversationId: c.id,
      ...messageRef(m, mentionUserIds),
      kind: c.kind,
      conversationName: c.kind === 'channel' ? c.name : null,
      memberUserIds: r.memberUserIds,
      notifyUserIds: r.notifyUserIds,
      hereUserIds: r.hereUserIds,
      userIds: r.userIds,
    },
  });
}
