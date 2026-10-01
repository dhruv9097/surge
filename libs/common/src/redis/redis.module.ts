import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { RedisConfig } from '../config/config.js';

export const REDIS = Symbol('REDIS');

/**
 * Configured for fail-fast behaviour under load: with the offline queue
 * disabled, commands issued while Redis is unreachable reject immediately
 * instead of piling up in memory and being replayed in a burst on reconnect.
 */
export function createRedisClient(config: RedisConfig): Redis {
  return new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: config.REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
  });
}

@Injectable()
class RedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    redis.on('error', (err) => this.logger.error({ err }, 'Redis connection error'));
  }

  async onModuleInit() {
    await this.redis.connect();
  }

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Global()
@Module({})
export class RedisModule {
  static forRoot(config: RedisConfig): DynamicModule {
    return {
      module: RedisModule,
      providers: [{ provide: REDIS, useFactory: () => createRedisClient(config) }, RedisLifecycle],
      exports: [REDIS],
    };
  }
}
