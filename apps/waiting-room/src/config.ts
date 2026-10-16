import {
  admissionConfigSchema,
  baseConfigSchema,
  databaseConfigSchema,
  loadConfig,
  redisConfigSchema,
} from '@surge/common';
import { z } from 'zod';

export const configSchema = baseConfigSchema
  .extend({ SERVICE_NAME: baseConfigSchema.shape.SERVICE_NAME.default('waiting-room') })
  .extend(databaseConfigSchema.shape)
  .extend(redisConfigSchema.shape)
  .extend(admissionConfigSchema.shape)
  .extend({
    // How many buyers per second are let through to the booking API. This is
    // the knob that protects everything downstream: set it to what the
    // booking path can comfortably sustain, not what it can survive.
    ADMIT_RATE_PER_SECOND: z.coerce.number().positive().default(50),
    ADMISSION_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    QUEUE_RETENTION_HOURS: z.coerce.number().int().positive().default(48),
  });

export type Config = z.infer<typeof configSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export const loadAppConfig = () => loadConfig(configSchema);
