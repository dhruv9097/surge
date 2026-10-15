import { baseConfigSchema, databaseConfigSchema, loadConfig } from '@surge/common';
import { z } from 'zod';

export const configSchema = baseConfigSchema
  .extend({ SERVICE_NAME: baseConfigSchema.shape.SERVICE_NAME.default('worker') })
  .extend(databaseConfigSchema.shape)
  .extend({
    KAFKA_BROKERS: z
      .string()
      .min(1)
      .transform((v) => v.split(',').map((b) => b.trim())),
    // Partitions bound how many consumers can process orders in parallel.
    KAFKA_ORDERS_PARTITIONS: z.coerce.number().int().positive().default(6),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(200),
    OUTBOX_IDLE_POLL_MS: z.coerce.number().int().min(10).default(200),
    OUTBOX_RETENTION_HOURS: z.coerce.number().int().positive().default(72),
    // Attempts per message before it is parked on the dead-letter topic.
    PROCESSING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  });

export type Config = z.infer<typeof configSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export const loadAppConfig = () => loadConfig(configSchema);
