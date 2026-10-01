import {
  baseConfigSchema,
  databaseConfigSchema,
  loadConfig,
  redisConfigSchema,
} from '@surge/common';
import type { z } from 'zod';

export const configSchema = baseConfigSchema
  .extend({ SERVICE_NAME: baseConfigSchema.shape.SERVICE_NAME.default('booking-api') })
  .extend(databaseConfigSchema.shape)
  .extend(redisConfigSchema.shape);

export type Config = z.infer<typeof configSchema>;

export const loadAppConfig = () => loadConfig(configSchema);
