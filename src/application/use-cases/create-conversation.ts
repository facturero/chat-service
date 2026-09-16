import { BusinessRuleError, NotOrganizationMemberError, ValidationError } from '../../domain/errors.js';
import { ConversationType, isValidUuid, generateUuid } from '../../domain/value-objects.js';
import { MembershipsResolver, UnitOfWork } from '../ports.js';
import { Conversation, ConversationParticipant } from '../../domain/entities.js';

export interface CreateConversationInput {
    actorId: string;
    organizationId: string;
    type: string;
    title?: string | null;
    participantIds: string[];
}

export interface CreateConversationResult {
    conversationId: string;
    existed: boolean;
}

export class CreateConversationUseCase {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly memberships: MembershipsResolver,
    ) {}

    async execute(input: CreateConversationInput): Promise<CreateConversationResult> {
        const { actorId, organizationId, type, participantIds } = input;

        if (!ConversationType.isValid(type)) {
            throw new ValidationError('Tipo de conversación inválido');
        }
        if (!isValidUuid(actorId)) {
            throw new ValidationError('actorId inválido');
        }

        const uniqueIds = [...new Set(participantIds)];
        for (const id of uniqueIds) {
            if (!isValidUuid(id)) {
                throw new ValidationError(`participantId inválido: ${id}`);
            }
        }

        if (uniqueIds.includes(actorId)) {
            throw new ValidationError('No puedes iniciar una conversación contigo mismo');
        }

        if (uniqueIds.length === 0) {
            throw new ValidationError('Se requiere al menos un participante');
        }

        if (type === ConversationType.Direct) {
            if (uniqueIds.length !== 1) {
                throw new ValidationError('Una conversación directa requiere exactamente 1 participante');
            }

            const existing = await this.uow.execute((repos) =>
                repos.conversations.findDirectByParticipants(organizationId, actorId, uniqueIds[0]),
            );
            if (existing) {
                return { conversationId: existing.id, existed: true };
            }
        } else {
            const title = input.title?.trim() ?? '';
            if (title.length === 0) {
                throw new BusinessRuleError('Un grupo requiere un título');
            }
        }

        const userIds = [actorId, ...uniqueIds];
        const results = await Promise.all(
            userIds.map((id) => this.memberships.isMember(id, organizationId)),
        );
        for (let i = 0; i < results.length; i++) {
            if (!results[i]) {
                throw new NotOrganizationMemberError(userIds[i], organizationId);
            }
        }

        return this.uow.execute(async (repos) => {
            const isGroup = type === ConversationType.Group;
            const title = isGroup ? (input.title?.trim() ?? null) : null;

            const conversation = Conversation.create({ organizationId, type, title, createdBy: actorId });

            const participants = [
                ConversationParticipant.create({
                    conversationId: conversation.id,
                    userId: actorId,
                    role: isGroup ? 'admin' : 'member',
                }),
                ...uniqueIds.map((id) =>
                    ConversationParticipant.create({ conversationId: conversation.id, userId: id, role: 'member' })
                ),
            ];

            await repos.conversations.save(conversation);
            for (const participant of participants) {
                await repos.participants.save(participant);
            }

            await repos.outbox.add({
                eventId: generateUuid(),
                type: 'conversation.created',
                aggregateType: 'conversation',
                aggregateId: conversation.id,
                payload: {
                    conversationId: conversation.id,
                    organizationId,
                    type,
                    title,
                    participantIds: uniqueIds,
                    createdBy: actorId,
                    createdAt: conversation.createdAt.toISOString(),
                },
                occurredAt: conversation.createdAt,
            });

            return { conversationId: conversation.id, existed: false };
        });

    }
}
