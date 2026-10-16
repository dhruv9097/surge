import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AdmissionTokens, ApiError, DatabaseService, REDIS, TtlCache } from '@surge/common';
import type { Redis } from 'ioredis';
import { Counter } from 'prom-client';
import { APP_CONFIG, type Config } from '../config.js';
import { QUEUE_STATUS, queueKeys } from './queue.scripts.js';

export type QueueStatus =
  | {
      status: 'waiting';
      eventId: string;
      position: number;
      estimatedWaitSeconds: number;
      saleOpensAt: string;
      pollAfterMs: number;
    }
  | { status: 'admitted'; eventId: string; token: string; expiresAt: string };

type ScriptFn = (...args: (string | number)[]) => Promise<(string | number)[]>;

const requests = new Counter({
  name: 'waiting_room_status_total',
  help: 'Queue status checks by result',
  labelNames: ['result'],
});

const MIN_POLL_MS = 2_000;
const MAX_POLL_MS = 30_000;

@Injectable()
export class QueueService {
  private readonly script: ScriptFn;
  private readonly saleOpens = new TtlCache<number | null>(30_000);
  private readonly tokens: AdmissionTokens;

  constructor(
    @Inject(REDIS) redis: Redis,
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {
    redis.defineCommand('surgeQueueStatus', { numberOfKeys: 3, lua: QUEUE_STATUS });
    this.script = (redis as unknown as Record<string, ScriptFn>).surgeQueueStatus!.bind(redis);
    this.tokens = new AdmissionTokens(config.ADMISSION_TOKEN_SECRET);
  }

  join(eventId: string, userId: string) {
    return this.status(eventId, userId, true);
  }

  async status(eventId: string, userId: string, join = false): Promise<QueueStatus> {
    const opensAt = await this.saleOpensAt(eventId);
    const k = queueKeys(eventId);
    const rate = this.config.ADMIT_RATE_PER_SECOND;
    const reply = await this.script(
      k.seq,
      k.members,
      k.gate,
      userId,
      rate,
      opensAt,
      join ? '1' : '0',
      this.config.QUEUE_RETENTION_HOURS * 3_600_000,
    );

    if (reply[0] === 'NOT_IN_QUEUE') {
      requests.inc({ result: 'not_in_queue' });
      throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_IN_QUEUE', 'Join the queue first');
    }

    const seq = Number(reply[1]);
    const admitted = Number(reply[2]);
    if (seq <= admitted) {
      requests.inc({ result: 'admitted' });
      const { token, expiresAt } = await this.tokens.sign(
        { userId, eventId },
        this.config.ADMISSION_TOKEN_TTL_SECONDS,
      );
      return { status: 'admitted', eventId, token, expiresAt: expiresAt.toISOString() };
    }

    requests.inc({ result: 'waiting' });
    const position = seq - admitted;
    const untilOpenMs = Math.max(0, opensAt - Date.now());
    const estimatedWaitMs = untilOpenMs + (position / rate) * 1_000;
    return {
      status: 'waiting',
      eventId,
      position,
      estimatedWaitSeconds: Math.ceil(estimatedWaitMs / 1_000),
      saleOpensAt: new Date(opensAt).toISOString(),
      // People far back are told to poll less often, which keeps polling
      // load roughly flat no matter how long the queue gets.
      pollAfterMs: Math.round(Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, estimatedWaitMs / 4))),
    };
  }

  private async saleOpensAt(eventId: string): Promise<number> {
    const opensAt = await this.saleOpens.get(eventId, async () => {
      const { rows } = await this.db.query<{ sale_opens_at: Date }>(
        'SELECT sale_opens_at FROM events WHERE id = $1',
        [eventId],
      );
      return rows[0]?.sale_opens_at.getTime() ?? null;
    });
    if (opensAt === null) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'EVENT_NOT_FOUND', 'Event not found');
    }
    return opensAt;
  }
}
