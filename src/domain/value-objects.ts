import { randomUUID } from 'node:crypto';


export type ConversationType = 'direct' | 'group';
export const ConversationType ={
    Direct: 'direct' as ConversationType,
    Group: 'group' as ConversationType,
    values: ['direct', 'group'] as ConversationType[],
    isValid: (v: string): v is ConversationType => ['direct', 'group'].includes(v),
};

export type ContentType = 'text' | 'image' | 'audio' | 'file';
export const ContentType = {
    Text: 'text' as ContentType,
    Image: 'image' as ContentType,
    Audio: 'audio' as ContentType,
    File: 'file' as ContentType,
    values: ['text', 'image', 'audio', 'file'] as ContentType[],
    isValid: (v: string): v is ContentType => ['text', 'image', 'audio', 'file'].includes(v),
};

export type MessageStatus = 'sent' | 'delivered' | 'read' | 'deleted';
export const MessageStatus = {
    Sent: 'sent' as MessageStatus,
    Delivered: 'delivered' as MessageStatus,
    Read: 'read' as MessageStatus,
    Deleted: 'deleted' as MessageStatus,
    values: ['sent', 'delivered', 'read', 'deleted'] as MessageStatus[],
    isValid: (v: string): v is MessageStatus => ['sent', 'delivered', 'read', 'deleted'].includes(v),
    canTransition: (from: MessageStatus, to: MessageStatus): boolean => {
        const transitions: Record<MessageStatus, MessageStatus[]> = {
            sent: ['delivered', 'deleted'],
            delivered: ['read', 'deleted'],
            read: ['deleted'],
            deleted: [],
        };
        return transitions[from]?.includes(to) ?? false;
    },
};

export type ParticipantStatus = 'delivered' | 'read';
export const ParticipantStatus = {
    Delivered: 'delivered' as ParticipantStatus,
    Read: 'read' as ParticipantStatus,
    values: ['delivered', 'read'] as ParticipantStatus[],
    isValid: (v: string): v is ParticipantStatus => ['delivered', 'read'].includes(v),
}

export type ParticipantRole = 'member' | 'admin';
export const ParticipantRole = {
    Member: 'member' as ParticipantRole,
    Admin: 'admin' as ParticipantRole,
    values: ['member', 'admin'] as ParticipantRole[],
    isValid: (v: string): v is ParticipantRole => ['member', 'admin'].includes(v),
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isValidUuid = (id: string): boolean => UUID_V4_REGEX.test(id);

export const generateUuid = (): string => randomUUID();