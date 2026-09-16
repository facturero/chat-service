import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { isValidUuid } from '../../domain/value-objects.js';
import { UnitOfWork } from '../ports.js';


export interface GetConversationInput {
    actorId: string;
    organizationId: string;
    conversationId: string;
}

export interface GetConversationResult {
    id: string;
    type: 'direct' | 'group';
    title: string | null;
    isActive: boolean;
    lastMessageAt: string | null;
    createdAt: string;
    participants: Array<{
        userId: string;
        role: 'member' | 'admin';
        joinedAt: string;
        lastReadAt: string | null;
    }>;
}

export class GetConversationUseCase {
    constructor(private readonly uow: UnitOfWork) {}

    async execute(input: GetConversationInput): Promise<GetConversationResult> {
        const { actorId, organizationId, conversationId } = input;

        if (!isValidUuid(actorId)) {
            throw new ValidationError('actorId inválido');
        }
        if (!isValidUuid(conversationId)) {
            throw new ValidationError('conversationId inválido');
        }

        const found = await this.uow.execute((repos) =>
            repos.conversations.findByIdWithParticipants(conversationId),
        );

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

        return {
            id: conversation.id,
            type: conversation.type,
            title: conversation.title,
            isActive: conversation.isActive,
            lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
            createdAt: conversation.createdAt.toISOString(),
            participants: participants
                .filter((p) => !p.hasLeft())
                .map((p) => ({
                    userId: p.userId,
                    role: p.role,
                    joinedAt: p.joinedAt.toISOString(),
                    lastReadAt: p.lastReadAt?.toISOString() ?? null,
                })),
        };
    }
}