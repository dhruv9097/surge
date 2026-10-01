import { z } from 'zod';

/**
 * Settings every service needs. Services extend this with their own fields
 * (`baseConfigSchema.extend({...})`) and load it once at startup, so a bad
 * deploy fails immediately with a readable error instead of at first use.
 */
export const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_HTTP_REQUESTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Time between failing readiness and closing the server, so the load
  // balancer stops routing to this instance before connections are drained.
  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().nonnegative().default(5_000),
  // Hard ceiling on graceful shutdown; must stay below the orchestrator's
  // kill timeout (docker compose `stop_grace_period`).
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});

export const databaseConfigSchema = z.object({
  DATABASE_URL: z.url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
});

export const redisConfigSchema = z.object({
  REDIS_URL: z.url(),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type RedisConfig = z.infer<typeof redisConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
