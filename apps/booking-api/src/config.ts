import {
  admissionConfigSchema,
  baseConfigSchema,
  databaseConfigSchema,
  loadConfig,
  redisConfigSchema,
} from '@surge/common';
import { z } from 'zod';

export const configSchema = baseConfigSchema
  .extend({ SERVICE_NAME: baseConfigSchema.shape.SERVICE_NAME.default('booking-api') })
  .extend(databaseConfigSchema.shape)
  .extend(redisConfigSchema.shape)
  .extend(admissionConfigSchema.shape)
  .extend({
    // How long seats stay reserved while a buyer checks out.
    HOLD_TTL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(30 * 60_000)
      .default(5 * 60_000),
  });

export type Config = z.infer<typeof configSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export const loadAppConfig = () => loadConfig(configSchema);
