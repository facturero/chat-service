import { Hono, type Context } from 'hono';
import type { ConversationUseCases } from '../../application/use-cases/conversation-use-cases.js';
import type { MessageUseCases } from '../../application/use-cases/message-use-cases.js';
import type { EmojiUseCases } from '../../application/use-cases/emoji-use-cases.js';
import type { CustomEmoji } from '../../domain/types.js';
import { ConversationNotFoundError, MessageNotFoundError, ValidationError } from '../../domain/errors.js';
import { actorMiddleware, internalSecretMiddleware, type ContextVariables } from './middlewares.js';
import {
  channelListingDto,
  conversationDetailDto,
  conversationSummaryDto,
  inboxDto,
  memberDto,
  membershipDto,
  messageDto,
} from './serializers.js';
import {
  addMembersSchema,
  createConversationSchema,
  editMessageSchema,
  reactionSchema,
  repliesQuerySchema,
  searchQuerySchema,
  threadsQuerySchema,
  createEmojiSchema,
  threadReadSchema,
  isUuid,
  messagesQuerySchema,
  parseBody,
  parseWith,
  preferencesSchema,
  readSchema,
  sendMessageSchema,
  updateConversationSchema,
} from './validators.js';

export interface AppDependencies {
  useCases: { conversations: ConversationUseCases; messages: MessageUseCases; emojis: EmojiUseCases };
  corsOrigin: string;
  internalSecret: string;
}

type Ctx = Context<{ Variables: ContextVariables }>;

function convId(c: Ctx): string {
  const id = c.req.param('conversationId');
  if (!isUuid(id)) throw new ConversationNotFoundError();
  return id.toLowerCase();
}

function msgId(c: Ctx): string {
  const id = c.req.param('messageId');
  if (!isUuid(id)) throw new MessageNotFoundError();
  return id.toLowerCase();
}

const flag = (v: string | undefined) => v === 'true' || v === '1';

/** El grupo de esa reacción tras el cambio (vacío si ya nadie la tiene). */
function reactionSummary(groups: Array<{ emoji: string; userIds: string[] }>, emoji: string, viewerId: string) {
  const g = groups.find((x) => x.emoji === emoji.trim());
  return { emoji: emoji.trim(), count: g?.userIds.length ?? 0, userIds: g?.userIds ?? [], mine: !!g?.userIds.includes(viewerId) };
}

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  return r;
}

/** Rutas de `openapi.yaml` que ya existen (E1). Las de hilos, reacciones, editar/borrar y búsqueda llegan en E2–E4. */
export function chatRoutes(deps: AppDependencies): Hono<{ Variables: ContextVariables }> {
  const { conversations, messages, emojis } = deps.useCases;
  const r = new Hono<{ Variables: ContextVariables }>();
  r.use('/chat/*', actorMiddleware());

  // ── Conversaciones ──
  r.get('/chat/conversations', async (c) => {
    const list = await conversations.list(c.get('actor'), flag(c.req.query('includeArchived')));
    return c.json({ items: list.map(conversationSummaryDto) });
  });
  r.post('/chat/conversations', async (c) => {
    const { conversation, existed } = await conversations.create(c.get('actor'), await parseBody(c, createConversationSchema));
    return c.json(conversationDetailDto(conversation), existed ? 200 : 201);
  });
  r.get('/chat/conversations/browse', async (c) => {
    const list = await conversations.browse(c.get('actor'), c.req.query('q') ?? null, flag(c.req.query('includeArchived')));
    return c.json({ items: list.map(channelListingDto) });
  });
  r.get('/chat/conversations/:conversationId', async (c) => c.json(conversationDetailDto(await conversations.get(c.get('actor'), convId(c)))));
  r.patch('/chat/conversations/:conversationId', async (c) =>
    c.json(conversationDetailDto(await conversations.update(c.get('actor'), convId(c), await parseBody(c, updateConversationSchema)))),
  );
  r.post('/chat/conversations/:conversationId/archive', async (c) => c.json(conversationDetailDto(await conversations.setArchived(c.get('actor'), convId(c), true))));
  r.post('/chat/conversations/:conversationId/unarchive', async (c) => c.json(conversationDetailDto(await conversations.setArchived(c.get('actor'), convId(c), false))));
  r.post('/chat/conversations/:conversationId/join', async (c) => c.json(conversationDetailDto(await conversations.join(c.get('actor'), convId(c)))));
  r.get('/chat/conversations/:conversationId/members', async (c) => c.json({ items: (await conversations.members(c.get('actor'), convId(c))).map(memberDto) }));
  r.post('/chat/conversations/:conversationId/members', async (c) => {
    const { userIds } = await parseBody(c, addMembersSchema);
    return c.json({ items: (await conversations.addMembers(c.get('actor'), convId(c), userIds)).map(memberDto) });
  });
  r.delete('/chat/conversations/:conversationId/members/:userId', async (c) => {
    const userId = c.req.param('userId');
    if (!isUuid(userId)) throw new ValidationError([{ field: 'userId', message: 'Id inválido.' }]);
    await conversations.removeMember(c.get('actor'), convId(c), userId.toLowerCase());
    return c.body(null, 204);
  });
  r.post('/chat/conversations/:conversationId/read', async (c) => {
    const { seq } = await parseBody(c, readSchema);
    return c.json(await conversations.markRead(c.get('actor'), convId(c), seq));
  });
  r.patch('/chat/conversations/:conversationId/preferences', async (c) =>
    c.json(membershipDto(await conversations.setPreferences(c.get('actor'), convId(c), await parseBody(c, preferencesSchema)))),
  );

  // ── Mensajes ──
  r.get('/chat/conversations/:conversationId/messages', async (c) => {
    const q = parseWith(messagesQuerySchema, c.req.query());
    const page = await messages.list(c.get('actor'), convId(c), q);
    const me = c.get('actor').userId;
    const reactions = await messages.reactionsFor(page.items.map((m) => m.id));
    return c.json({
      items: page.items.map((m) => messageDto(m, me, reactions.get(m.id))),
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      lastReadSeq: page.lastReadSeq,
    });
  });
  r.post('/chat/conversations/:conversationId/messages', async (c) => {
    const { message, existed } = await messages.send(c.get('actor'), convId(c), await parseBody(c, sendMessageSchema));
    return c.json(messageDto(message, c.get('actor').userId), existed ? 200 : 201);
  });
  r.get('/chat/messages/:messageId', async (c) => {
    const m = await messages.get(c.get('actor'), msgId(c));
    return c.json(messageDto(m, c.get('actor').userId, (await messages.reactionsFor([m.id])).get(m.id)));
  });
  r.patch('/chat/messages/:messageId', async (c) => {
    const { bodyDoc } = await parseBody(c, editMessageSchema);
    const m = await messages.edit(c.get('actor'), msgId(c), bodyDoc);
    return c.json(messageDto(m, c.get('actor').userId, (await messages.reactionsFor([m.id])).get(m.id)));
  });
  r.delete('/chat/messages/:messageId', async (c) => {
    await messages.remove(c.get('actor'), msgId(c));
    return c.body(null, 204);
  });
  r.get('/chat/messages/:messageId/replies', async (c) => {
    const q = parseWith(repliesQuerySchema, c.req.query());
    const me = c.get('actor').userId;
    const { root, items, hasMore } = await messages.replies(c.get('actor'), msgId(c), q);
    const reactions = await messages.reactionsFor([root.id, ...items.map((m) => m.id)]);
    return c.json({ root: messageDto(root, me, reactions.get(root.id)), items: items.map((m) => messageDto(m, me, reactions.get(m.id))), hasMore });
  });
  r.post('/chat/messages/:messageId/reactions', async (c) => {
    const { emoji } = await parseBody(c, reactionSchema);
    return c.json(reactionSummary(await messages.react(c.get('actor'), msgId(c), emoji, true), emoji, c.get('actor').userId));
  });
  r.delete('/chat/messages/:messageId/reactions/:emoji', async (c) => {
    const emoji = decodeURIComponent(c.req.param('emoji'));
    return c.json(reactionSummary(await messages.react(c.get('actor'), msgId(c), emoji, false), emoji, c.get('actor').userId));
  });

  // ── Bandeja ──
  // ── Emojis personalizados ──
  const emojiDto = (e: CustomEmoji) => ({ id: e.id, name: e.name, documentId: e.documentId, createdBy: e.createdBy, createdAt: e.createdAt.toISOString() });
  r.get('/chat/emojis', async (c) => c.json({ items: (await emojis.list(c.get('actor'))).map(emojiDto) }));
  r.post('/chat/emojis', async (c) => c.json(emojiDto(await emojis.create(c.get('actor'), await parseBody(c, createEmojiSchema))), 201));
  r.delete('/chat/emojis/:emojiId', async (c) => {
    const id = c.req.param('emojiId');
    if (!isUuid(id)) throw new ValidationError([{ field: 'emojiId', message: 'Id inválido.' }]);
    await emojis.remove(c.get('actor'), id.toLowerCase());
    return c.body(null, 204);
  });

  // ── Hilos (vista «Hilos») ──
  r.get('/chat/threads', async (c) => {
    const me = c.get('actor').userId;
    const { items, nextCursor } = await messages.threads(c.get('actor'), parseWith(threadsQuerySchema, c.req.query()));
    const reactions = await messages.reactionsFor(items.flatMap((x) => [x.root.id, ...x.latestReplies.map((m) => m.id)]));
    return c.json({
      items: items.map((x) => ({
        root: messageDto(x.root, me, reactions.get(x.root.id)),
        conversation: { id: x.conversation.id, kind: x.conversation.kind, name: x.conversation.kind === 'channel' ? x.conversation.name : null },
        latestReplies: x.latestReplies.map((m) => messageDto(m, me, reactions.get(m.id))),
        lastReadThreadSeq: x.lastReadThreadSeq,
        unreadCount: x.unreadCount,
        mentionCount: x.mentionCount,
      })),
      nextCursor,
    });
  });
  r.post('/chat/messages/:messageId/thread/read', async (c) => {
    const { threadSeq } = await parseBody(c, threadReadSchema);
    return c.json(await messages.markThreadRead(c.get('actor'), msgId(c), threadSeq));
  });

  r.get('/chat/search', async (c) => {
    const me = c.get('actor').userId;
    const { items, nextCursor } = await messages.search(c.get('actor'), parseWith(searchQuerySchema, c.req.query()));
    return c.json({
      items: items.map((h) => ({
        message: messageDto(h.message, me),
        conversation: { id: h.conversation.id, kind: h.conversation.kind, name: h.conversation.kind === 'channel' ? h.conversation.name : null },
        snippet: h.snippet,
      })),
      nextCursor,
    });
  });
  r.get('/chat/unread', async (c) => c.json(inboxDto(await conversations.unread(c.get('actor')), c.get('actor').userId)));

  return r;
}

/** Rutas internas: solo el hub del gateway, con `X-Internal-Secret`, directo (no pasan por el gateway). */
export function internalRoutes(deps: AppDependencies): Hono {
  const r = new Hono();
  r.use('/internal/*', internalSecretMiddleware(deps.internalSecret));
  const org = (c: Context) => {
    const id = c.req.query('organizationId');
    if (!isUuid(id)) throw new ValidationError([{ field: 'organizationId', message: 'Obligatorio (uuid).' }]);
    return id.toLowerCase();
  };
  r.get('/internal/messages/:messageId', async (c) => {
    const id = c.req.param('messageId');
    if (!isUuid(id)) throw new MessageNotFoundError();
    return c.json(messageDto(await deps.useCases.messages.internalGet(org(c), id.toLowerCase())));
  });
  r.get('/internal/conversations/:conversationId/members', async (c) => {
    const id = c.req.param('conversationId');
    if (!isUuid(id)) throw new ConversationNotFoundError();
    return c.json({ userIds: await deps.useCases.conversations.internalMemberIds(org(c), id.toLowerCase()) });
  });
  return r;
}
