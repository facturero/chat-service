import type { Context } from 'hono';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { CONVERSATION_KINDS, NOTIFY_LEVELS, VISIBILITIES, type ConversationKind, type NotifyLevel, type Visibility } from '../../domain/types.js';

const uuid = z.string().uuid();

export const createConversationSchema = z.object({
  kind: z.enum(CONVERSATION_KINDS as [ConversationKind, ...ConversationKind[]]),
  name: z.string().max(200).optional(),
  visibility: z.enum(VISIBILITIES as [Visibility, ...Visibility[]]).optional(),
  topic: z.string().max(250).optional(),
  description: z.string().max(1000).optional(),
  userIds: z.array(uuid).max(50).optional(),
});

export const updateConversationSchema = z
  .object({
    name: z.string().max(200).optional(),
    topic: z.string().max(250).nullable().optional(),
    description: z.string().max(1000).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.topic !== undefined || v.description !== undefined, { message: 'Indica qué cambiar.' });

export const addMembersSchema = z.object({ userIds: z.array(uuid).min(1).max(50) });
export const readSchema = z.object({ seq: z.number().int().min(0) });
export const preferencesSchema = z
  .object({ notify: z.enum(NOTIFY_LEVELS as [NotifyLevel, ...NotifyLevel[]]).optional(), muted: z.boolean().optional() })
  .refine((v) => v.notify !== undefined || v.muted !== undefined, { message: 'Indica qué cambiar.' });

export const sendMessageSchema = z.object({
  clientMsgId: uuid,
  // El documento lo valida el dominio (`richtext.ts`, lista blanca); aquí solo que sea un objeto.
  bodyDoc: z.record(z.unknown()),
  threadRootId: uuid.nullable().optional(),
});

export const editMessageSchema = z.object({ bodyDoc: z.record(z.unknown()) });
export const reactionSchema = z.object({ emoji: z.string().min(1).max(64) });

const optionalInt = z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(0).optional());

export const messagesQuerySchema = z.object({
  before: optionalInt,
  after: optionalInt,
  around: uuid.optional(),
  limit: z.preprocess((v) => (v === undefined || v === '' ? 50 : Number(v)), z.number().int().min(1).max(100)),
});

export const createEmojiSchema = z.object({ name: z.string().min(1).max(64), documentId: uuid });

export const threadsQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.preprocess((v) => (v === undefined || v === '' ? 20 : Number(v)), z.number().int().min(1).max(50)),
});

export const threadReadSchema = z.object({ threadSeq: z.number().int().min(0) });

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  conversationId: uuid.optional(),
  fromUserId: uuid.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.preprocess((v) => (v === undefined || v === '' ? 20 : Number(v)), z.number().int().min(1).max(50)),
});

export const repliesQuerySchema = z.object({
  after: optionalInt,
  limit: z.preprocess((v) => (v === undefined || v === '' ? 100 : Number(v)), z.number().int().min(1).max(100)),
});

/** Lee y valida el cuerpo JSON. Un error de forma sale como 422 con el detalle por campo, igual que en el resto de servicios. */
export async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError([{ field: 'body', message: 'El cuerpo debe ser JSON.' }]);
  }
  return parseWith(schema, raw);
}

export function parseWith<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })));
  }
  return parsed.data;
}

/** Los ids de la ruta también se validan: un id que no es uuid es 404, no un error de la base. */
export function isUuid(value: string | undefined): value is string {
  return !!value && uuid.safeParse(value).success;
}
