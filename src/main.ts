import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { AppError } from './domain/errors.js';
import { OutboxRelay } from '@facturero/outbox-relay';

function createApp(): Hono {
  const app = new Hono();

  app.use('*', cors({ origin: config.CORS_ORIGIN }));

  app.onError((err: Error, c) => {
    const status = err instanceof AppError ? err.httpStatus : 500;
    const code = err instanceof AppError ? err.code : 'INTERNAL_SERVER_ERROR';
    const message = err.message || 'Internal server error';
    if (status === 500) {
      console.error('[chat-service] error:', err);
    }
    return c.json({ code, message, status }, status as ContentfulStatusCode);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  return app;
}

async function main(): Promise<void> {
  console.log('[chat-service] config resuelta:', JSON.stringify({
    PORT: config.PORT,
    DB_HOST: config.DB_HOST,
    DB_NAME: config.DB_NAME,
    RABBITMQ_URL: config.RABBITMQ_URL || '(no configurado)',
  }));

  await sequelize.authenticate();
  console.log('[chat-service] conexión a BD ok');

  const app = createApp();
  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[chat-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    const relay = new OutboxRelay({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
    });
    await relay.start();
    console.log('[chat-service] OutboxRelay iniciado.');
  } else {
    console.log('[chat-service] RABBITMQ_URL no configurado, outbox relay desactivado.');
  }
}

main().catch((err) => {
  console.error('[chat-service] error al iniciar:', err);
  process.exit(1);
});