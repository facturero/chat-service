import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { isValidUuid } from '../../domain/value-objects.js';
import { UnitOfWork } from '../ports.js';

export interface ListMessagesInput {
    actorId: string;
    organizationId: string;
    conversationId: string;
    cursor?: string | null;
    limit?: number | null;
}

export interface MessageDto {
    id: string;
    conversationId: string;
    senderId: string;
    contentType: string;
    content: string | null;
    attachmentId: string | null;
    attachmentUrl: string | null;
    status: string;
    deliveredAt: string | null;
    readAt: string | null;
    editedAt: string | null;
    replyTo: string | null;
    createdAt: string;
}

export interface ListMessagesResult {
    messages: MessageDto[];
    nextCursor: string | null;
}

export class ListMessagesUseCase {
    constructor(private readonly uow: UnitOfWork) {}

    async execute(input: ListMessagesInput): Promise<ListMessagesResult> {
        const { actorId, organizationId, conversationId } = input;

        if (!isValidUuid(actorId)) {
            throw new ValidationError('actorId inválido');
        }
        if (!isValidUuid(conversationId)) {
            throw new ValidationError('conversationId inválido');
        }

        const limit = input.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1  || limit > 100){
            throw new ValidationError('limit debe estar entre 1 y 100');
        }

        let cursor: Date | undefined;
        if (input.cursor){
            const parsed = new Date(input.cursor);
            if (isNaN(parsed.getTime())){
                throw new ValidationError('cursor inválido');
            }
            cursor = parsed;
        }

        return this.uow.execute(async (repos) => {
            const found = await repos.conversations.findByIdWithParticipants(conversationId);
            if (!found) {
                throw new NotFoundError('Conversation', conversationId);
            }

            const { conversation, participants } = found;

            if (!conversation.belongsToOrganization(organizationId)) {
                throw new NotFoundError('Conversation', conversationId);
            }

            const isActiveParticipant = participants.some(
                (p) => p.userId === actorId && !p.hasLeft(),
            )
            if (!isActiveParticipant) {
                throw new ForbiddenError('No eres participante de esta conversación');
            }

            const deletions = await repos.messageDeletions.findByConversationAndUser(conversationId, actorId);
            const hidden = new Set(deletions.map((d) => d.messageId));

            const messages = await repos.messages.findByConversation(conversationId, cursor, limit + 1);
            const hasMore = messages.length > limit;
            const page = hasMore ? messages.slice(0, limit) : messages;
            const nextCursor = hasMore && page.length > 0
                ? page[page.length - 1].createdAt.toISOString()
                : null;
            
            return {
                messages: page
                    .filter((m) => !hidden.has(m.id))
                    .map((m) => ({
                        id: m.id,
                        conversationId: m.conversationId,
                        senderId: m.senderId,
                        contentType: m.contentType,
                        content: m.isDeleted() ? null : m.content,
                        attachmentId: m.isDeleted() ? null : m.attachmentId,
                        attachmentUrl: m.isDeleted() ? null : m.attachmentUrl,
                        status: m.status,
                        deliveredAt: m.deliveredAt?.toISOString() ?? null,
                        readAt: m.readAt?.toISOString() ?? null,
                        editedAt: m.editedAt?.toISOString() ?? null,
                        replyTo: m.replyTo,
                        createdAt: m.createdAt.toISOString(),
                    })),
                nextCursor,
            }
        });
    }
}