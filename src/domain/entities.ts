import { randomUUID } from "node:crypto";
import { ConversationType, ContentType, MessageStatus, ParticipantRole, ParticipantStatus, isValidUuid } from './value-objects.js';
import { BusinessRuleError, ValidationError } from './errors.js';

export interface ConversationProps {
    id: string;
    type: ConversationType;
    title: string | null;
    createdBy: string;
    isActive: boolean;
    lastMessageAt: Date | null;
    createdAt: Date;
    updatedAt: Date;  
}

export class Conversation {
    private constructor(private props: ConversationProps){}

    static create(params: { type: ConversationType; title?: string | null; createdBy: string}): Conversation {
        if(params.type === 'group' && !params.title){
            throw new BusinessRuleError('Un grupo requiere título');
        }

        const now = new Date();
        return new Conversation({
            id: randomUUID(),
            type: params.type,
            title: params.title ?? null,
            createdBy: params.createdBy,
            isActive: true,
            lastMessageAt: null,
            createdAt: now,
            updatedAt: now,
        });
    }

    static fromPersistence(props: ConversationProps): Conversation {
        return new Conversation({ ...props});
    }

    get id(): string { return this.props.id; }
    get type(): ConversationType { return this.props.type; }
    get title(): string | null { return this.props.title; }
    get createdBy(): string { return this.props.createdBy; }
    get isActive(): boolean { return this.props.isActive; }
    get lastMessageAt(): Date | null { return this.props.lastMessageAt; }
    get createdAt(): Date { return this.props.createdAt; }
    get updatedAt(): Date { return this.props.updatedAt; }

    isGroup(): boolean { return this.props.type === 'group'; }

    rename(title: string): void {
        if(!this.isGroup()) throw new BusinessRuleError('No se puede renombrar una conversación directa');
        this.props.title = title;
        this.props.updatedAt = new Date();
    }

    updateLastMessageAt(at: Date): void {
        this.props.lastMessageAt = at;
        this.props.updatedAt = new Date();
    }

    deactivate(): void {
        this.props.isActive = false;
        this.props.updatedAt = new Date();
    }

    toPersistence(): ConversationProps { return {...this.props}; }
}

export interface conversationParticipantProps {
    conversationId: string;
    userId: string;
    role: ParticipantRole;
    joinedAt: Date;
    lastReadAt: Date | null;
    leftAt: Date | null;
}

export class ConversationParticipant {
    private constructor(private props: conversationParticipantProps){}

    static create(params: { conversationId: string; userId: string; role?: ParticipantRole}): ConversationParticipant {
        return new ConversationParticipant({
            conversationId: params.conversationId,
            userId: params.userId,
            role: params.role ?? 'member',
            joinedAt: new Date(),
            lastReadAt: null,
            leftAt: null,
        });
    }

    static fromPersistence(props: conversationParticipantProps): ConversationParticipant {
        return new ConversationParticipant({ ...props});
    }

    get conversationId(): string { return this.props.conversationId; }
    get userId(): string { return this.props.userId; }
    get role(): ParticipantRole { return this.props.role; }
    get joinedAt(): Date { return this.props.joinedAt; }
    get lastReadAt(): Date | null { return this.props.lastReadAt; }
    get leftAt(): Date | null { return this.props.leftAt; }

    isAdmin(): boolean { return this.props.role === 'admin'; }
    hasLeft(): boolean { return this.props.leftAt !== null; }

    markAsRead(at: Date): void {
        this.props.lastReadAt = at;
    }

    leave(at: Date): void {
        this.props.leftAt = at;
    }

    toPersistence(): conversationParticipantProps { return {...this.props}; }
}

export interface MessageVersionProps {
    id: string;
    messageId: string;
    content: string;
    editedBy: string;
    editedAt: Date;
}

export class MessageVersion {
    private constructor(private props: MessageVersionProps){}

    static create(params: { messageId: string; content: string; editedBy: string; editedAt: Date}) : MessageVersion {
        return new MessageVersion({ id: randomUUID(), ...params});
    }

    static fromPersistence(props: MessageVersionProps): MessageVersion {
        return new MessageVersion({ ...props});
    }

    get id(): string { return this.props.id; }
    get messageId(): string { return this.props.messageId; }
    get content(): string { return this.props.content; }
    get editedBy(): string { return this.props.editedBy; }
    get editedAt(): Date { return this.props.editedAt; }

    toPersistence(): MessageVersionProps { return {...this.props}; }
}

export interface MessageProps {
    id: string;
    conversationId: string;
    senderId: string;
    contentType: ContentType;
    content: string;
    attachmentId: string | null;
    attachmentUrl: string | null;
    status: MessageStatus;
    deliveredAt: Date | null;
    readAt: Date | null;
    editedAt: Date | null;
    replyTo: string | null;
    createdAt: Date;
}

export class Message {
    private constructor(private props: MessageProps){}

    static create(params: { 
        conversationId: string; 
        senderId: string; 
        contentType: ContentType; 
        content: string; 
        attachmentId?: string | null; 
        attachmentUrl?: string | null; 
        replyTo?: string | null
    }): Message {
        if(params.contentType === 'text' && params.content.trim().length === 0){
            throw new ValidationError('El contenido del mensaje no puede estar vacío');
        }
        if(params.contentType !== 'text' && !params.attachmentId){
            throw new ValidationError('Un adjunto requiere un attachmentId');
        }

        return new Message({
            id: randomUUID(),
            conversationId: params.conversationId,
            senderId: params.senderId,
            contentType: params.contentType,
            content: params.content,
            attachmentId: params.attachmentId ?? null,
            attachmentUrl: params.attachmentUrl ?? null,
            status: 'sent',
            deliveredAt: null,
            readAt: null,
            editedAt: null,
            replyTo: params.replyTo ?? null,
            createdAt: new Date(),
        });
    }

    static fromPersistence(props: MessageProps): Message {
        return new Message({ ...props});
    }

    get id(): string { return this.props.id; }
    get conversationId(): string { return this.props.conversationId; }
    get senderId(): string { return this.props.senderId; }
    get contentType(): ContentType { return this.props.contentType; }
    get content(): string { return this.props.content; }
    get attachmentId(): string | null { return this.props.attachmentId; }
    get attachmentUrl(): string | null { return this.props.attachmentUrl; }
    get status(): MessageStatus { return this.props.status; }
    get deliveredAt(): Date | null { return this.props.deliveredAt; }
    get readAt(): Date | null { return this.props.readAt; }
    get editedAt(): Date | null { return this.props.editedAt; }
    get replyTo(): string | null { return this.props.replyTo; }
    get createdAt(): Date { return this.props.createdAt; }

    isDeleted(): boolean { return this.props.status === 'deleted'; }

    private transition(to: MessageStatus): void {
        if(!MessageStatus.canTransition(this.props.status, to)){
            throw new BusinessRuleError(`No se puede cambiar el estado de ${this.props.status} a ${to}`);
        }
        this.props.status = to;
    }
    
    markDelivered(at: Date): void {
        this.transition('delivered');
        this.props.deliveredAt = at;
    }

    markRead(at: Date): void {
        this.transition('read');
        this.props.readAt = at;
    }

    delete(): void {
        this.transition('deleted');
    }

    edit(newContent: string, editedBy: string, at: Date): MessageVersion {
        if(this.isDeleted()) throw new BusinessRuleError('No se puede editar un mensaje borrado');
        if(!isValidUuid(editedBy)) throw new ValidationError('editedBy inválido');
        const version = MessageVersion.create({
            messageId: this.props.id,
            content: this.props.content,
            editedBy,
            editedAt: at,
        });
        this.props.content = newContent;
        this.props.editedAt = at;
        return version;
    }

    toPersistence(): MessageProps { return {...this.props}; }
}

export interface ParticipantMessageProps {
    messageId: string;
    participantUserId: string;
    status: ParticipantStatus;
    statusAt: Date;
}

export class ParticipantMessage {
    private constructor(private props: ParticipantMessageProps){}

    static create(params: { messageId: string; participantUserId: string; status?: ParticipantStatus; at?: Date }): ParticipantMessage {
        const at = params.at ?? new Date();
        return new ParticipantMessage({
            messageId: params.messageId,
            participantUserId: params.participantUserId,
            status: params.status ?? 'delivered',
            statusAt: at,
        });
    }

    static fromPersistence(props: ParticipantMessageProps): ParticipantMessage {
        return new ParticipantMessage({ ...props});
    }

    get messageId(): string { return this.props.messageId; }
    get participantUserId(): string { return this.props.participantUserId; }
    get status(): ParticipantStatus { return this.props.status; }
    get statusAt(): Date { return this.props.statusAt; }

    markAsRead(at: Date): void {
        if(this.props.status === 'read') return;
        this.props.status = 'read';
        this.props.statusAt = at;
    }

    toPersistence(): ParticipantMessageProps { return {...this.props}; }
}

export interface MessageDeletionProps {
    id: string;
    messageId: string;
    deletedBy: string;
    deletedAt: Date;
}

export class MessageDeletion {
    private constructor(private props: MessageDeletionProps){}

    static create(params: { messageId: string; deletedBy: string; deletedAt?: Date }): MessageDeletion {
        return new MessageDeletion({ id: randomUUID(), ...params, deletedAt: params.deletedAt ?? new Date() });
    }

    static fromPersistence(props: MessageDeletionProps): MessageDeletion {
        return new MessageDeletion({ ...props});
    }

    get id(): string { return this.props.id; }
    get messageId(): string { return this.props.messageId; }
    get deletedBy(): string { return this.props.deletedBy; }
    get deletedAt(): Date { return this.props.deletedAt; }

    toPersistence(): MessageDeletionProps { return {...this.props}; }
}