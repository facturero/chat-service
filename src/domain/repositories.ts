import {
  Conversation,
  ConversationParticipant,
  Message,
  MessageDeletion,
  MessageVersion,
  ParticipantMessage,
} from './entities.js';

/* Outbox messages for RabbitMQ */
export interface DomainEvent {
    eventId: string;
    type: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
}

export interface OutboxRepository {
    add(event: DomainEvent): Promise<void>;
}

/* Processed events (consumer idempotence) */
export interface ProcessedEventRepository {
    exists(eventId: string): Promise<boolean>;
    save(eventId: string): Promise<void>;
}

export interface UnitOfWork {
    execute<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export interface Repositories {
    conversations: ConversationRepository;
    participants: ConversationParticipantRepository;
    messages: MessageRepository;
    participantMessages: ParticipantMessageRepository;
    messageVersions: MessageVersionRepository;
    messageDeletions: MessageDeletionRepository;
    outbox: OutboxRepository;
    processedEvents: ProcessedEventRepository;
}

export interface ConversationRepository {
    save(conversation: Conversation): Promise<void>;
    findById(id: string): Promise<Conversation | null>;
    findByUser(userId: string, limit?: number): Promise<Conversation[]>;
    findByIdWithParticipants(id: string): Promise<Conversation | null>;
    updateLastMessageAt(id: string, at: Date): Promise<void>;
}

export interface ConversationParticipantRepository {
    save(participant: ConversationParticipant): Promise<void>;
    findByConversation(conversationId: string): Promise<ConversationParticipant[]>;
    findByConversationAndUser(conversationId: string, userId: string): Promise<ConversationParticipant | null>;
    updateLastReadAt(conversationId: string, userId: string, at: Date): Promise<void>;
    delete(conversationId: string, userId: string): Promise<void>;
}

export interface MessageRepository {
    save(message: Message): Promise<void>;
    findById(id: string): Promise<Message | null>;
    findByConversation(conversationId: string, cursor?: Date, limit?: number): Promise<Message[]>;
    updateStatus(id: string, status: string, at?: Date): Promise<void>;
    updateContent(id: string, newContent: string, editedAt: Date): Promise<void>;
    markDeleted(id: string): Promise<void>;
}

export interface ParticipantMessageRepository {
    save(pm: ParticipantMessage): Promise<void>;
    findByMessage(messageId: string): Promise<ParticipantMessage[]>;
    findByMessageAndUser(messageId: string, userId: string): Promise<ParticipantMessage | null>;
    upsertStatus(messageId: string, userId: string, status: 'delivered' | 'read', at: Date): Promise<void>;
}

export interface MessageVersionRepository {
    save(version: MessageVersion): Promise<void>;
    findByMessage(messageId: string): Promise<MessageVersion[]>;
}

export interface MessageDeletionRepository {
    save(deletion: MessageDeletion): Promise<void>;
    exists(messageId: string, userId: string): Promise<boolean>;
    findByMessage(messageId: string): Promise<MessageDeletion[]>;
}