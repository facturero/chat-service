import { DataTypes, InferAttributes, InferCreationAttributes, Model } from 'sequelize';
import { sequelize } from './sequelize.js';

export class ConversationModel extends Model<
    InferAttributes<ConversationModel>, InferCreationAttributes<ConversationModel>
>{
    declare id: string;
    declare type: 'direct' | 'group';
    declare title: string | null;
    declare created_by: string;
    declare organization_id: string;
    declare is_active: boolean;
    declare last_message_at: Date | null;
    declare created_at: Date;
    declare updated_at: Date;
    declare participants?: ConversationParticipantModel[];
}

ConversationModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    type: { type: DataTypes.ENUM('direct', 'group'), allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_message_at: { type: DataTypes.DATE, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'conversations', timestamps: false },
);

export class ConversationParticipantModel extends Model<
    InferAttributes<ConversationParticipantModel>, InferCreationAttributes<ConversationParticipantModel>
>{
    declare conversation_id: string;
    declare user_id: string;
    declare role: 'member' | 'admin';
    declare joined_at: Date;
    declare last_read_at: Date | null;
    declare left_at: Date | null;
    declare conversation?: ConversationModel;
}

ConversationParticipantModel.init(
  {
    conversation_id: { type: DataTypes.CHAR(36), primaryKey: true },
    user_id: { type: DataTypes.CHAR(36), primaryKey: true },
    role: { type: DataTypes.ENUM('member', 'admin'), allowNull: false, defaultValue: 'member' },
    joined_at: { type: DataTypes.DATE, allowNull: false },
    last_read_at: { type: DataTypes.DATE, allowNull: true },
    left_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'conversation_participants', timestamps: false },
);

export class MessageModel extends Model<
    InferAttributes<MessageModel>, InferCreationAttributes<MessageModel>
>{
    declare id: string;
    declare conversation_id: string;
    declare sender_id: string;
    declare content_type: 'text' | 'image' | 'audio' | 'file';
    declare content: string | null;
    declare attachment_id: string | null;
    declare attachment_url: string | null;
    declare status: 'sent' | 'delivered' | 'read' | 'deleted';
    declare delivered_at: Date | null;
    declare read_at: Date | null;
    declare edited_at: Date | null;
    declare reply_to: string | null;
    declare created_at: Date;
    declare conversation?: ConversationModel;
    declare reply?: MessageModel;
}

MessageModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    conversation_id: { type: DataTypes.CHAR(36), allowNull: false },
    sender_id: { type: DataTypes.CHAR(36), allowNull: false },
    content_type: {
      type: DataTypes.ENUM('text', 'image', 'audio', 'file'),
      allowNull: false,
      defaultValue: 'text',
    },
    content: { type: DataTypes.TEXT, allowNull: true },
    attachment_id: { type: DataTypes.CHAR(36), allowNull: true },
    attachment_url: { type: DataTypes.STRING(500), allowNull: true },
    status: {
      type: DataTypes.ENUM('sent', 'delivered', 'read', 'deleted'),
      allowNull: false,
      defaultValue: 'sent',
    },
    delivered_at: { type: DataTypes.DATE, allowNull: true },
    read_at: { type: DataTypes.DATE, allowNull: true },
    edited_at: { type: DataTypes.DATE, allowNull: true },
    reply_to: { type: DataTypes.CHAR(36), allowNull: true },
    created_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'messages', timestamps: false },
);

export class ParticipantMessageModel extends Model<
    InferAttributes<ParticipantMessageModel>, InferCreationAttributes<ParticipantMessageModel>
>{
    declare message_id: string;
    declare participant_user_id: string;
    declare status: 'delivered' | 'read';
    declare status_at: Date;
}

ParticipantMessageModel.init(
  {
    message_id: { type: DataTypes.CHAR(36), primaryKey: true },
    participant_user_id: { type: DataTypes.CHAR(36), primaryKey: true },
    status: { type: DataTypes.ENUM('delivered', 'read'), allowNull: false },
    status_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'participant_messages', timestamps: false },
);

export class MessageVersionModel extends Model<
    InferAttributes<MessageVersionModel>, InferCreationAttributes<MessageVersionModel>
>{
    declare id: string;
    declare message_id: string;
    declare content: string;
    declare edited_by: string;
    declare edited_at: Date;
}

MessageVersionModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    message_id: { type: DataTypes.CHAR(36), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    edited_by: { type: DataTypes.CHAR(36), allowNull: false },
    edited_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'message_versions', timestamps: false },
);

export class MessageDeletionModel extends Model<
    InferAttributes<MessageDeletionModel>, InferCreationAttributes<MessageDeletionModel>
>{
    declare id: string;
    declare message_id: string;
    declare deleted_by: string;
    declare deleted_at: Date;
    declare message?: MessageModel;
}

MessageDeletionModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    message_id: { type: DataTypes.CHAR(36), allowNull: false },
    deleted_by: { type: DataTypes.CHAR(36), allowNull: false },
    deleted_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'message_deletions', timestamps: false },
);

export class OutboxModel extends Model<
    InferAttributes<OutboxModel>, InferCreationAttributes<OutboxModel>
>{
    declare id: string;
    declare aggregate_type: string;
    declare aggregate_id: string;
    declare type: string;
    declare payload: Record<string, unknown>;
    declare occurred_at: Date;
    declare processed_at: Date | null;
}

OutboxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    aggregate_type: { type: DataTypes.STRING(50), allowNull: false },
    aggregate_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    processed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'outbox_messages', timestamps: false },
);

export class ProcessedEventModel extends Model<
    InferAttributes<ProcessedEventModel>, InferCreationAttributes<ProcessedEventModel>
>{
    declare event_id: string;
    declare processed_at: Date;
}

ProcessedEventModel.init(
  {
    event_id: { type: DataTypes.CHAR(36), primaryKey: true },
    processed_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'processed_events', timestamps: false },
);

ConversationModel.hasMany(ConversationParticipantModel, { foreignKey: 'conversation_id', as: 'participants' });
ConversationParticipantModel.belongsTo(ConversationModel, { foreignKey: 'conversation_id', as: 'conversation' });
ConversationModel.hasMany(MessageModel, { foreignKey: 'conversation_id', as: 'messages' });
MessageModel.belongsTo(ConversationModel, { foreignKey: 'conversation_id', as: 'conversation' });
MessageModel.belongsTo(MessageModel, { foreignKey: 'reply_to', as: 'reply' });
MessageModel.hasMany(ParticipantMessageModel, { foreignKey: 'message_id', as: 'participantMessages' });
ParticipantMessageModel.belongsTo(MessageModel, { foreignKey: 'message_id', as: 'message' });
MessageModel.hasMany(MessageVersionModel, { foreignKey: 'message_id', as: 'versions' });
MessageVersionModel.belongsTo(MessageModel, { foreignKey: 'message_id', as: 'message' });
MessageModel.hasMany(MessageDeletionModel, { foreignKey: 'message_id', as: 'deletions' });
MessageDeletionModel.belongsTo(MessageModel, { foreignKey: 'message_id', as: 'message' });