import './infrastructure/telemetry/otel.js';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { AuthTeamDirectory } from './infrastructure/http/auth-directory.js';
import { startEventConsumer } from './infrastructure/messaging/consumer.js';
import { ConversationUseCases } from './application/use-cases/conversation-use-cases.js';
import { MessageUseCases, SendRateLimiter } from './application/use-cases/message-use-cases.js';
import { EmojiUseCases } from './application/use-cases/emoji-use-cases.js';
import { createApp } from './interface/http/app.js';

async function main(): Promise<void> {
  // NO `sequelize.sync()`: la migración (initContainer chat-migrate) es la fuente de verdad del esquema.
  await sequelize.authenticate();

  let relay: OutboxRelay | undefined;
  const gateway = new SequelizeUnitOfWorkFactory((tx) => relay?.attachToTransaction(tx));
  const clock = () => new Date();
  const ids = () => randomUUID();
  if (!config.INTERNAL_SERVICE_SECRET) console.warn('[chat-service] INTERNAL_SERVICE_SECRET vacío: #general no se podrá crear y /internal/* responderá 401');

  const conversations = new ConversationUseCases(gateway, readOnlyRepositories, new AuthTeamDirectory(config.AUTH_SERVICE_URL, config.INTERNAL_SERVICE_SECRET), clock, ids);
  const limiter = new SendRateLimiter(config.SEND_RATE_PER_MINUTE || Number.MAX_SAFE_INTEGER);
  const messages = new MessageUseCases(gateway, readOnlyRepositories, limiter, clock, ids);

  const emojis = new EmojiUseCases(readOnlyRepositories, clock, ids);
  const app = createApp({ useCases: { conversations, messages, emojis }, corsOrigin: config.CORS_ORIGIN, internalSecret: config.INTERNAL_SERVICE_SECRET });
  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[chat-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    relay = new OutboxRelay({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events' });
    await relay.start();
    await startEventConsumer({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events', conversations });
    console.log('[chat-service] outbox relay activo; consume identity.user.accepted_invite/disabled/enabled');
  } else {
    console.warn('[chat-service] RABBITMQ_URL no configurado: los eventos NO se publican');
  }
}

main().catch((err) => {
  console.error('[chat-service] error al iniciar:', err);
  process.exit(1);
});
