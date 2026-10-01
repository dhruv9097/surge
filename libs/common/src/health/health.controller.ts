import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { DatabaseService } from '../database/database.service.js';
import { REDIS } from '../redis/redis.module.js';
import { LifecycleService } from './lifecycle.service.js';

// Dependency checks are cached briefly so probes and load balancers polling
// every second cannot themselves become load on the database during a spike.
const CHECK_TIMEOUT_MS = 1_000;
const CHECK_CACHE_MS = 2_000;

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly lifecycle: LifecycleService,
    @Optional() private readonly db?: DatabaseService,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  /** Liveness: the process is up and the event loop is responsive. No dependencies. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: this instance should receive traffic. */
  @Get('ready')
  @HealthCheck()
  ready() {
    if (this.lifecycle.isDraining) {
      throw new ServiceUnavailableException({ status: 'draining' });
    }
    const { db, redis } = this;
    return this.health.check([
      ...(db
        ? [
            () =>
              this.indicators
                .check('database')
                .attempt(async () => {
                  await db.query('SELECT 1');
                })
                .withTimeout(CHECK_TIMEOUT_MS)
                .cacheFor(CHECK_CACHE_MS),
          ]
        : []),
      ...(redis
        ? [
            () =>
              this.indicators
                .check('redis')
                .attempt(async () => {
                  await redis.ping();
                })
                .withTimeout(CHECK_TIMEOUT_MS)
                .cacheFor(CHECK_CACHE_MS),
          ]
        : []),
    ]);
  }
}
