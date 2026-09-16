import { ValidationError } from '../../domain/errors.js';
import { isValidUuid } from '../../domain/value-objects.js';
import { UnitOfWork } from '../ports.js';

export interface ListConversationsInput {
    actorId: string;
    organizationId: string;
    limit?: number;
}

export interface ConversationListItem {
    id: string;
    type: 'direct' | 'group';
    title: string | null;
    isActive: boolean;
    lastMessageAt: string | null;
    createdAt: string;
}

export class ListConversationsUseCase {
    constructor(private readonly uow: UnitOfWork) {}

    async execute(input: ListConversationsInput): Promise<ConversationListItem[]> {
        const { actorId, organizationId } = input;

        if (!isValidUuid(actorId)) {
            throw new ValidationError('actorId inválido');
        }

        const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

        const conversations = await this.uow.execute((repos) =>
            repos.conversations.findByUser(actorId, organizationId, limit), 
        );

        return conversations.map((c) => ({
            id: c.id,
            type: c.type,
            title: c.title,
            isActive: c.isActive,
            lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
            createdAt: c.createdAt.toISOString(),
        }));
    }
}