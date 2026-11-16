import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3007),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  RABBITMQ_URL: z.string().optional(),
  // Directorio del equipo (#general) y secreto de las rutas internas (`/internal/*`, las llama el hub del gateway).
  AUTH_SERVICE_URL: z.string().default('http://auth-service:3001'),
  INTERNAL_SERVICE_SECRET: z.string().default(''),
  CORS_ORIGIN: z.string().default('*'),
  // Mensajes por minuto por persona (regla de IMPLEMENTATION.md). 0 lo apaga (pruebas de carga).
  SEND_RATE_PER_MINUTE: z.coerce.number().int().min(0).default(30),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Configuración de entorno inválida:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;
