

export class AppError extends Error {
    constructor(
        public readonly code: string,
        public readonly httpStatus: number,
        message: string,
        public readonly details?: Record<string, unknown>
    ){
        super(message);
        this.name = 'AppError';
    }
}

// Error code 400 - validation errors
export class ValidationError extends AppError {
    constructor(message: string, details?: Record<string, unknown>) {
        super('VALIDATION_ERROR', 400, message, details);
        this.name = 'ValidationError';
    }
}

// Error code 401 - authentication errors
export class UnauthorizedError extends AppError {
    constructor(message = 'Not authorized') {
        super('UNAUTHORIZED', 401, message);
        this.name = 'UnauthorizedError';
    }
}

// Error code 403 - You do not have permission -> (no es participante, no es autor/admin)
export class ForbiddenError extends AppError {
    constructor(message = 'Access denied') {
        super('FORBIDDEN', 403, message);
        this.name = 'ForbiddenError';
    }
}

// Error code 404 - Not found
export class NotFoundError extends AppError {
    constructor(resource: string, id?: string) {
        super('NOT_FOUND', 404, `${resource} ${id ? `with id ${id} ` : ''}not found`);
        this.name = 'NotFoundError';
    }
}

// Error code 409 - Conflict
export class ConflictError extends AppError {
    constructor(message: string) {
        super('CONFLICT', 409, message);
        this.name = 'ConflictError';
    }
}

// Error code 422 - Business rule violated
export class BusinessRuleError extends AppError {
    constructor(message: string) {
        super('BUSINESS_RULE_VIOLATION', 422, message);
        this.name = 'BusinessRuleError';
    }
}

// Error code 500 - Internal server error
export class InternalServerError extends AppError {
    constructor(message = 'Internal server error') {
        super('INTERNAL_SERVER_ERROR', 500, message);
        this.name = 'InternalServerError';
    }
}