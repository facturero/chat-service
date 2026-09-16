import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { ContentType, isValidUuid, generateUuid } from '../../domain/value-objects.js';
import { UnitOfWork } from '../ports.js';
import { Message } from '../../domain/entities.js';

export const MAX_CONTENT_LENGTH = 4000;
export const MAX_ATTACHMENT_URL_LENGTH = 500;

export interface SendMessageInput {
    actorId: string;
    organizationId: string;
    conversationId: string;
    contentType?: string | null;
    content?: string | null;
    attachmentId?: string | null;
    attachmentUrl?: string | null;
    replyTo?: string | null;
}

export interface SendMessageResult {
    id: string;
    conversationId: string;
    senderId: string;
    contentType: ContentType;
    content: string;
    attachmentId: string | null;
    attachmentUrl: string | null;
    status: string;
    replyTo: string | null;
    createdAt: string;
}

export class SendMessageUseCase {
    constructor(private readonly uow: UnitOfWork) {}

    async execute(input: SendMessageInput): Promise<SendMessageResult> {
        const { actorId, organizationId, conversationId } = input;

        if (!isValidUuid(actorId)) {
            throw new ValidationError('actorId inválido');
        }
        if (!isValidUuid(conversationId)) {
            throw new ValidationError('conversationId inválido');
        }

        const contentType = input.contentType ?? ContentType.Text;
        if (!ContentType.isValid(contentType)) {
            throw new ValidationError('contentType inválido');
        }

        const content = input.content?.trim() ?? '';
        if (content.length > MAX_CONTENT_LENGTH) {
            throw new ValidationError(`El contenido excede el límite de ${MAX_CONTENT_LENGTH} caracteres`);
        }

        const attachmentId = input.attachmentId ?? null;
        if (contentType !== ContentType.Text) {
            if (!attachmentId) {
                throw new ValidationError('Un adjunto requiere un attachmentId');
            }
            if (!isValidUuid(attachmentId)) {
                throw new ValidationError('attachmentId inválido');
            }
        }

        const attachmentUrl = input.attachmentUrl ?? null;
        if (attachmentUrl && attachmentUrl.length > MAX_ATTACHMENT_URL_LENGTH) {
            throw new ValidationError(`attachmentUrl excede el límite de ${MAX_ATTACHMENT_URL_LENGTH} caracteres`);
        }

        const replyTo = input.replyTo ?? null;
        if (replyTo && !isValidUuid(replyTo)) {
            throw new ValidationError('replyTo inválido');
        }

        const message = await this.uow.execute(async (repos) => {
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
            );
            if (!isActiveParticipant) {
                throw new ForbiddenError('No eres participante de esta conversación');
            }

            if (replyTo) {
                const reply = await repos.messages.findById(replyTo);
                if (!reply || reply.conversationId !== conversationId) {
                    throw new ValidationError('El mensaje de respuesta no pertenece a esta conversación');
                }
            }

            const created = Message.create({
                conversationId,
                senderId: actorId,
                contentType,
                content,
                attachmentId,
                attachmentUrl,
                replyTo,
            });

            await repos.messages.save(created);
            await repos.conversations.updateLastMessageAt(conversationId, created.createdAt);

            await repos.outbox.add({
                eventId: generateUuid(),
                type: 'message.created',
                aggregateType: 'message',
                aggregateId: created.id,
                payload: {
                    messageId: created.id,
                    conversationId,
                    senderId: actorId,
                    contentType,
                    content,
                    attachmentId,
                    attachmentUrl,
                    replyTo,
                    status: created.status,
                    organizationId,
                    createdAt: created.createdAt.toISOString(),
                },
                occurredAt: created.createdAt,
            });

            return created;
        });

        return {
            id: message.id,
            conversationId: message.conversationId,
            senderId: message.senderId,
            contentType: message.contentType,
            content: message.content,
            attachmentId: message.attachmentId,
            attachmentUrl: message.attachmentUrl,
            status: message.status,
            replyTo: message.replyTo,
            createdAt: message.createdAt.toISOString(),
        };
    }
}