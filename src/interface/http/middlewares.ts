import { timingSafeEqual } from 'node:crypto';
import { type Context, type MiddlewareHandler } from 'hono';
import { runWithActor } from '@facturero/outbox-relay';
import { AppError, InternalAuthError, OrganizationContextRequiredError, UserContextRequiredError } from '../../domain/errors.js';
import type { Actor } from '../../domain/types.js';

export type ContextVariables = { actor: Actor };

/**
 * El gateway inyecta quién actúa (`X-User-Id`, `X-Organization-Id`, `X-Permissions`). Los ids se pasan a minúsculas: se comparan como
 * texto con los guardados. Quien actúa viaja además en un contexto asíncrono hasta el outbox (actor, IP y request-id en cada evento).
 */
export function actorMiddleware(): MiddlewareHandler<{ Variables: ContextVariables }> {
  return async (c, next) => {
    const organizationId = c.req.header('X-Organization-Id')?.toLowerCase();
    const userId = c.req.header('X-User-Id')?.toLowerCase();
    if (!organizationId) throw new OrganizationContextRequiredError();
    if (!userId) throw new UserContextRequiredError();
    const permissions = (c.req.header('X-Permissions') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    c.set('actor', { userId, organizationId, permissions });
    await runWithActor(
      {
        actorId: userId,
        actorEmail: c.req.header('X-User-Email') ?? null,
        actorIp: c.req.header('X-Client-Ip') ?? null,
        requestId: c.req.header('X-Request-Id') ?? null,
      },
      () => next(),
    );
  };
}

/** Rutas `/internal/*`: solo con el secreto compartido (las llama el hub del gateway directo, sin pasar por el gateway). */
export function internalSecretMiddleware(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const given = c.req.header('X-Internal-Secret') ?? '';
    const ok = secret.length > 0 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
    if (!ok) throw new InternalAuthError();
    await next();
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'SequelizeUniqueConstraintError';
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    // `@hono/otel` marca como error del span todo lo que llega aquí; en el servidor solo los 5xx son error.
    if (err.httpStatus < 500) c.error = undefined;
    return c.json({ code: err.code, message: err.message, status: err.httpStatus, ...(err.details ? { details: err.details } : {}) }, err.httpStatus as 400);
  }
  if (isUniqueConstraintError(err)) {
    c.error = undefined;
    return c.json({ code: 'CONFLICT', message: 'Ya existe un registro con esos datos.', status: 409 }, 409);
  }
  console.error('[chat-service] error no controlado:', err);
  return c.json({ code: 'INTERNAL_ERROR', message: 'Error interno del servidor.', status: 500 }, 500);
}
