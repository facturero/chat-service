import { type EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import type { ConversationUseCases } from '../../application/use-cases/conversation-use-cases.js';

/** Lo que consume chat-service (asyncapi.yaml → `subscribe`). `scripts/check-asyncapi-events.mjs` lo coteja con el contrato. */
export const CONSUMED_BINDINGS = ['identity.user.accepted_invite', 'identity.user.disabled', 'identity.user.enabled'] as const;

function ids(payload: unknown): { userId: string; organizationId: string } | null {
  const p = (payload ?? {}) as { userId?: unknown; organizationId?: unknown };
  if (typeof p.userId !== 'string' || typeof p.organizationId !== 'string') return null;
  return { userId: p.userId.toLowerCase(), organizationId: p.organizationId.toLowerCase() };
}

/**
 * Altas y bajas del equipo (auth-service) por InboxConsumer: idempotente por `eventId` (`processed_events`), con reintentos y su propia
 * cola de espera. Estos eventos no llevan nada privado, así que guardar su payload es inocuo.
 */
export function buildHandlers(conversations: ConversationUseCases): EventHandler[] {
  return [
    {
      eventType: 'identity.user.accepted_invite',
      handle: async (payload) => {
        const p = ids(payload);
        if (p) await conversations.onUserJoinedOrganization(p.organizationId, p.userId);
      },
    },
    {
      eventType: 'identity.user.enabled',
      handle: async (payload) => {
        const p = ids(payload);
        if (p) await conversations.onUserJoinedOrganization(p.organizationId, p.userId);
      },
    },
    {
      eventType: 'identity.user.disabled',
      handle: async (payload) => {
        const p = ids(payload);
        if (p) await conversations.onUserDisabled(p.organizationId, p.userId);
      },
    },
  ];
}

export async function startEventConsumer(opts: { sequelize: Sequelize; rabbitmqUrl: string; exchange: string; conversations: ConversationUseCases }): Promise<InboxConsumer> {
  const consumer = new InboxConsumer({
    sequelize: opts.sequelize,
    rabbitmqUrl: opts.rabbitmqUrl,
    exchange: opts.exchange,
    queue: 'chat-service.events',
    bindings: [...CONSUMED_BINDINGS],
    handlers: buildHandlers(opts.conversations),
  });
  await consumer.start();
  return consumer;
}
