export interface ErrorDetail {
  field: string;
  message: string;
}

/** Error de negocio con su código y su estado HTTP. El formato de respuesta es el de todos los servicios: `{ code, message, details? }`. */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
  constructor(details: ErrorDetail[], message = 'La petición no es válida.') {
    super(message, details);
  }
}

export class OrganizationContextRequiredError extends AppError {
  readonly code = 'ORG_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de organización.') { super(message); }
}

export class UserContextRequiredError extends AppError {
  readonly code = 'USER_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de usuario.') { super(message); }
}

export class InternalAuthError extends AppError {
  readonly code = 'INTERNAL_AUTH_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta o no coincide el secreto interno.') { super(message); }
}

/** Puede leer la conversación pero no hacer esto (no es el dueño, no es el autor…). */
export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'No puedes hacer esto en esta conversación.') { super(message); }
}

/**
 * No existe, es de otra organización, o es un canal privado / DM donde no se es miembro: siempre el mismo 404. Un 403 diría que existe.
 */
export class EmojiNotFoundError extends AppError {
  readonly code = 'EMOJI_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Ese emoji no existe.') { super(message); }
}

export class ConversationNotFoundError extends AppError {
  readonly code = 'CONVERSATION_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Conversación no encontrada.') { super(message); }
}

export class MessageNotFoundError extends AppError {
  readonly code = 'MESSAGE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Mensaje no encontrado.') { super(message); }
}

export class ConversationArchivedError extends AppError {
  readonly code = 'CONVERSATION_ARCHIVED';
  readonly httpStatus = 409;
  constructor(message = 'El canal está archivado: es de solo lectura.') { super(message); }
}

export class NameTakenError extends AppError {
  readonly code = 'NAME_TAKEN';
  readonly httpStatus = 409;
  constructor(message = 'Ya existe un canal con ese nombre.') { super(message); }
}

export class GeneralIsMandatoryError extends AppError {
  readonly code = 'GENERAL_IS_MANDATORY';
  readonly httpStatus = 409;
  constructor(message = 'Nadie sale de #general ni se puede archivar.') { super(message); }
}

export class UserInactiveError extends AppError {
  readonly code = 'USER_INACTIVE';
  readonly httpStatus = 409;
  constructor(message = 'Esa persona ya no está activa en la organización.') { super(message); }
}

export class NotApplicableError extends AppError {
  readonly code = 'NOT_APPLICABLE';
  readonly httpStatus = 409;
  constructor(message = 'Esto no aplica a este tipo de conversación.') { super(message); }
}

export class RateLimitedError extends AppError {
  readonly code = 'RATE_LIMITED';
  readonly httpStatus = 429;
  constructor(message = 'Demasiados mensajes seguidos. Espera un momento.') { super(message); }
}
