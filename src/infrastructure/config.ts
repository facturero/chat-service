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
    AUTH_SERVICE_URL: z.string().default('http://auth-service:3001'),
    INTERNAL_SERVICE_SECRET: z.string().default(''),
    CORS_ORIGIN: z.string().default('*'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    const issues = parsed.error.issues
        .map((i) =>  ` - ${i.path.join('.')} : ${i.message}`)
        .join('\n');
    console.error(` Invalid environment variables:\n${issues}`);
    process.exit(1);
}

const env = parsed.data;

export interface AppConfig {
    NODE_ENV: 'development' | 'test' | 'production';
    PORT: number;
    DB_HOST: string;
    DB_PORT: number;
    DB_USER: string;
    DB_PASSWORD: string;
    DB_NAME: string;
    RABBITMQ_URL: string | undefined;
    AUTH_SERVICE_URL: string;
    INTERNAL_SERVICE_SECRET: string;
    CORS_ORIGIN: string;
}

export const config: AppConfig = {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    DB_HOST: env.DB_HOST,
    DB_PORT: env.DB_PORT,
    DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD,
    DB_NAME: env.DB_NAME,
    RABBITMQ_URL: env.RABBITMQ_URL,
    AUTH_SERVICE_URL: env.AUTH_SERVICE_URL,
    INTERNAL_SERVICE_SECRET: env.INTERNAL_SERVICE_SECRET,
    CORS_ORIGIN: env.CORS_ORIGIN,
}