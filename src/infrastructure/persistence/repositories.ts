import { Op, Transaction } from 'sequelize';
import { sequelize } from './sequelize.js';
import {
  ConversationModel,
  ConversationParticipantModel,
  MessageModel,
  MessageDeletionModel,
  MessageVersionModel,
  OutboxModel,
  ParticipantMessageModel,
  ProcessedEventModel,
} from './models.js';
import {
  Conversation,
  ConversationParticipant,
  Message,
  MessageDeletion,
  MessageVersion,
  ParticipantMessage,
} from '../../domain/entities.js';
import {
  ConversationParticipantRepository,
  ConversationRepository,
  DomainEvent,
  MessageDeletionRepository,
  MessageRepository,
  MessageVersionRepository,
  OutboxRepository,
  ParticipantMessageRepository,
  ProcessedEventRepository,
  Repositories,
} from '../../domain/repositories.js';
import { UnitOfWork } from '../../application/ports.js';
import { withActor } from '@facturero/outbox-relay';

function toConversation(m: ConversationModel): Conversation{
    return Conversation.fromPersistence({
        id: m.id,
        organizationId: m.organization_id,
        type: m.type,
        title: m.title,
        createdBy: m.created_by,
        isActive: m.is_active,
        lastMessageAt: m.last_message_at,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
    });
}

function toParticipant(m: ConversationParticipantModel): ConversationParticipant{
    return ConversationParticipant.fromPersistence({
        conversationId: m.conversation_id,
        userId: m.user_id,
        role: m.role,
        joinedAt: m.joined_at,
        lastReadAt: m.last_read_at,
        leftAt: m.left_at,
    });
}

function toMessage(m: MessageModel): Message{
    return Message.fromPersistence({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_id,
        contentType: m.content_type,
        content: m.content ?? '',
        attachmentId: m.attachment_id,
        attachmentUrl: m.attachment_url,
        status: m.status,
        deliveredAt: m.delivered_at,
        readAt: m.read_at,
        editedAt: m.edited_at,
        replyTo: m.reply_to,
        createdAt: m.created_at,
    });
}

function toParticipantMessage(m: ParticipantMessageModel): ParticipantMessage{
    return ParticipantMessage.fromPersistence({
        messageId: m.message_id,
        participantUserId: m.participant_user_id,
        status: m.status,
        statusAt: m.status_at,
    });
}

function toMessageVersion(m: MessageVersionModel): MessageVersion{
    return MessageVersion.fromPersistence({
        id: m.id,
        messageId: m.message_id,
        content: m.content,
        editedBy: m.edited_by,
        editedAt: m.edited_at,
    });
}

function toMessageDeletion(m: MessageDeletionModel): MessageDeletion{
    return MessageDeletion.fromPersistence({
        id: m.id,
        messageId: m.message_id,
        deletedBy: m.deleted_by,
        deletedAt: m.deleted_at,
    });
}

function conversationRepository(tx?: Transaction): ConversationRepository {
    return{
        async save(conversation: Conversation){
            const p = conversation.toPersistence();
            await ConversationModel.upsert(
                {
                    id: p.id,
                    type: p.type,
                    title: p.title,
                    created_by: p.createdBy,
                    organization_id: p.organizationId,
                    is_active: p.isActive,
                    last_message_at: p.lastMessageAt,
                    created_at: p.createdAt,
                    updated_at: p.updatedAt,
                },
                { transaction: tx },
            );
        },

        async findById(id: string){
            const m = await ConversationModel.findByPk(id, { transaction: tx });
            return m ? toConversation(m) : null;
        },

        async  findDirectByParticipants(organizationId: string, userIdA: string, userIdB: string){
            const rows = await ConversationParticipantModel.findAll({
                where: { user_id: { [Op.in]: [userIdA, userIdB] }},
                include: [
                    {
                    model: ConversationModel,
                    as: 'conversation',
                    where: { organization_id: organizationId, type: 'direct', is_active: true },
                    }
                ],
                transaction: tx,
            });

            const byConversation = new Map<string, string[]>();
            for (const row of rows){
                if (row.left_at) continue;
                const list = byConversation.get(row.conversation_id) ?? [];
                list.push(row.user_id);
                byConversation.set(row.conversation_id, list);
                if (row.conversation && list.includes(userIdA) && list.includes(userIdB)){
                    return toConversation(row.conversation);
                }
            }
            return null;
        },

        async findByUser(userId: string, organizationId: string, limit = 50){
            const rows = await ConversationParticipantModel.findAll({
                where: { user_id: userId, left_at: null },
                include: [{ model: ConversationModel, as: 'conversation', where: { organization_id: organizationId } }],
                order: [[{ model: ConversationModel, as: 'conversation' }, 'last_message_at', 'DESC']],
                limit,
                transaction: tx,
            });
            return rows.map((r) => toConversation(r.conversation!));
        },

        async findByIdWithParticipants(id: string){
            const m = await ConversationModel.findByPk(id, {
                include: [{ model: ConversationParticipantModel, as: 'participants' }],
                transaction: tx,
            });
            if (!m) return null;
            return {
                conversation: toConversation(m),
                participants: (m.participants ?? []).map(toParticipant),
            };
        },

        async  updateLastMessageAt(id: string, at: Date){
            await ConversationModel.update(
                { last_message_at: at, updated_at: new Date() },
                { where: { id }, transaction: tx },
            ); 
        }
    }
}

function participantRepository(tx?: Transaction): ConversationParticipantRepository {
    return {
        async save(participant: ConversationParticipant){
            const p = participant.toPersistence();
            await ConversationParticipantModel.upsert(
                {
                    conversation_id: p.conversationId,
                    user_id: p.userId,
                    role: p.role,
                    joined_at: p.joinedAt,
                    last_read_at: p.lastReadAt,
                    left_at: p.leftAt,
                },
                { transaction: tx }
            );
        },

        async findByConversation(conversationId: string){
            const rows = await ConversationParticipantModel.findAll({
                where: { conversation_id: conversationId },
                order: [['joined_at', 'ASC']],
                transaction: tx,
            });
            return rows.map(toParticipant);
        },

        async findByConversationAndUser(conversationId: string, userId: string){
            const m = await ConversationParticipantModel.findOne({
                where: { conversation_id: conversationId, user_id: userId },
                transaction: tx,
            });
            return m ? toParticipant(m) : null;
        },

        async updateLastReadAt(conversationId: string, userId: string, at: Date){
            await ConversationParticipantModel.update(
                { last_read_at: at },
                { where: { conversation_id: conversationId, user_id: userId }, transaction: tx }
            );
        },

        async delete(conversationId: string, userId: string){
            await ConversationParticipantModel.update(
                { left_at: new Date() },
                { where: { conversation_id: conversationId, user_id: userId }, transaction: tx }
            );
        },
    }
}

function messageRepository(tx?: Transaction): MessageRepository {
    return {
        async save(message: Message){
            const p = message.toPersistence();
            await MessageModel.upsert(
                {
                    id: p.id,
                    conversation_id: p.conversationId,
                    sender_id: p.senderId,
                    content_type: p.contentType,
                    content: p.content,
                    attachment_id: p.attachmentId,
                    attachment_url: p.attachmentUrl,
                    status: p.status,
                    delivered_at: p.deliveredAt,
                    read_at: p.readAt,
                    edited_at: p.editedAt,
                    reply_to: p.replyTo,
                    created_at: p.createdAt,
                },
                { transaction: tx }
            );
        },

        async  findById(id: string){
            const m = await MessageModel.findByPk(id, { transaction: tx });
            return m ? toMessage(m) : null;
        },

        async findByConversation(conversationId: string, cursor?: Date, limit = 50){
            const rows = await MessageModel.findAll({
                where: {
                    conversation_id: conversationId,
                    ...(cursor ? { created_at: { [Op.lt]: cursor } } : {}),
                },
                order: [['created_at', 'DESC']],
                limit,
                transaction: tx,
            });
            return rows.map(toMessage);
        },

        async updateStatus(id: string, status: string, at?: Date){
            const patch: Record<string, unknown> = { status };
            if (status === 'delivered') patch.delivered_at = at ?? new Date();
            if (status === 'read') patch.read_at = at ?? new Date();
            await MessageModel.update(patch, { where: { id }, transaction: tx });
        },

        async updateContent(id: string, newContent: string, editedAt: Date){
            await MessageModel.update(
                { content: newContent, edited_at: editedAt },
                { where: { id }, transaction: tx }
            );
        },

        async markDeleted(id: string){
            await MessageModel.update({ status: 'deleted' }, { where: { id }, transaction: tx });
        },
    }
}

function participantMessageRepository(tx?: Transaction): ParticipantMessageRepository {
    return {
        async save(pm: ParticipantMessage){
            const p = pm.toPersistence();
            await ParticipantMessageModel.upsert(
                {
                    message_id: p.messageId,
                    participant_user_id: p.participantUserId,
                    status: p.status,
                    status_at: p.statusAt,
                },
                { transaction: tx }
            );
        },

        async findByMessage(messageId: string){
            const rows = await ParticipantMessageModel.findAll({
                where: { message_id: messageId },
                order: [['status_at', 'ASC']],
                transaction: tx,
            });
            return rows.map(toParticipantMessage);
        },

        async findByMessageAndUser(messageId: string, userId: string){
            const m = await ParticipantMessageModel.findOne({
                where: { message_id: messageId, participant_user_id: userId },
                transaction: tx,
            });
            return m ? toParticipantMessage(m) : null;
        },

        async upsertStatus(messageId: string, userId: string, status: 'delivered' | 'read', at: Date){
            await ParticipantMessageModel.upsert(
                {
                 message_id: messageId,
                    participant_user_id: userId,
                    status,
                    status_at: at,
                },
                { transaction: tx }
            );
        },
    }
}

function messageVersionRepository(tx?: Transaction): MessageVersionRepository {
    return {
        async save(version: MessageVersion){
            const p = version.toPersistence();
            await MessageVersionModel.create(
                {
                    id: p.id,
                    message_id: p.messageId,
                    content: p.content,
                    edited_by: p.editedBy,
                    edited_at: p.editedAt,
                },
                { transaction: tx }
            );
        },

        async findByMessage(messageId: string){
            const rows = await MessageVersionModel.findAll({
                where: { message_id: messageId },
                order: [['edited_at', 'ASC']],
                transaction: tx,
            });
            return rows.map(toMessageVersion);
        },
    }
}

function messageDeletionRepository(tx?: Transaction): MessageDeletionRepository {
    return {
        async save(deletion: MessageDeletion){
            const p = deletion.toPersistence();
            await MessageDeletionModel.create(
                {
                    id: p.id,
                    message_id: p.messageId,
                    deleted_by: p.deletedBy,
                    deleted_at: p.deletedAt,
                },
                { transaction: tx }
            );
        },

        async exists(messageId: string, userId: string){
            const count = await MessageDeletionModel.count({
                where: { message_id: messageId, deleted_by: userId },
                transaction: tx,
            });
            return count > 0;
        },

        async findByMessage(messageId: string){
            const rows = await MessageDeletionModel.findAll({
                where: { message_id: messageId },
                transaction: tx,
            });
            return rows.map(toMessageDeletion);
        },

        async findByConversationAndUser(conversationId: string, userId: string){
            const rows = await MessageDeletionModel.findAll({
                include: [{model: MessageModel, as: 'message', where: { conversation_id: conversationId }}],
                where: { deleted_by: userId },
                transaction: tx,
            });
            return rows.map(toMessageDeletion);
        },
    }
}

function outboxRepository(tx?: Transaction): OutboxRepository {
    return {
        async add(event: DomainEvent){
            await OutboxModel.create(
                {
                    id: event.eventId,
                    aggregate_type: event.aggregateType,
                    aggregate_id: event.aggregateId,
                    type: event.type,
                    payload: withActor(event.payload as Record<string, unknown>),
                    occurred_at: event.occurredAt,
                    processed_at: null,
                },
                { transaction: tx }
            );
        },
    }
}

function  processedEventRepository(tx?: Transaction): ProcessedEventRepository {
    return {
        async exists(eventId: string){
            const row = await ProcessedEventModel.findByPk(eventId, { transaction: tx });
            return row !== null;
        },

        async save(eventId: string){
            await ProcessedEventModel.create(
                { event_id: eventId, processed_at: new Date() },
                { transaction: tx }
            );
        },
    }
}

export function buildRepositories(tx: Transaction | undefined): Repositories {
    return {
        conversations: conversationRepository(tx),
        participants: participantRepository(tx),
        messages: messageRepository(tx),
        participantMessages: participantMessageRepository(tx),
        messageVersions: messageVersionRepository(tx),
        messageDeletions: messageDeletionRepository(tx),
        outbox: outboxRepository(tx),
        processedEvents: processedEventRepository(tx),
    };
}

export class SequelizeUnitOfWork  implements UnitOfWork {
    async execute<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
        return sequelize.transaction(async (tx) =>  work(buildRepositories(tx)));
    }
}