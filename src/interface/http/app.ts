import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { type AppDependencies, chatRoutes, healthRoutes, internalRoutes } from './routes.js';
import { errorHandler } from './middlewares.js';

export function createApp(deps: AppDependencies, opts: { log?: boolean } = {}): Hono {
  const app = new Hono();

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    app.use('*', httpInstrumentationMiddleware({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'chat-service',
      captureRequestHeaders: ['x-request-id'],
      spanNameFactory: (c) => `HTTP ${c.req.method} ${c.req.path}`,
    }));
  }
  if (opts.log !== false) app.use('*', logger());
  app.use(
    '*',
    cors({
      origin: deps.corsOrigin,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id', 'X-User-Id', 'X-Permissions'],
    }),
  );

  app.route('/', healthRoutes());
  app.route('/', internalRoutes(deps));
  app.route('/', chatRoutes(deps));

  app.onError(errorHandler);
  app.notFound((c) => {
    c.error = undefined;
    return c.json({ code: 'NOT_FOUND', message: 'Recurso no encontrado.', status: 404 }, 404);
  });

  return app;
}
