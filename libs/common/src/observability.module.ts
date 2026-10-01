import type { IncomingMessage } from 'node:http';
import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { BaseConfig } from './config/config.js';
import { requestIdFor } from './http/request-id.js';
import { MetricsModule, startDefaultMetrics } from './metrics/metrics.module.js';

const QUIET_PATHS = new Set(['/metrics', '/health/live', '/health/ready']);

/**
 * Structured JSON logging and Prometheus metrics. When OpenTelemetry is
 * enabled its pino instrumentation adds trace_id/span_id to every log line,
 * so a log line in Loki links straight to its trace in Tempo.
 */
@Module({})
export class ObservabilityModule {
  static forRoot(config: BaseConfig): DynamicModule {
    startDefaultMetrics(config.SERVICE_NAME);
    return {
      module: ObservabilityModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            base: { service: config.SERVICE_NAME },
            transport:
              config.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { singleLine: true } }
                : undefined,
            // Fastify assigns the id first and its middleware layer copies it
            // onto the raw request, so logs and error bodies share one id.
            genReqId: (req: IncomingMessage & { id?: string }) => req.id ?? requestIdFor(req),
            autoLogging: {
              ignore: (req: IncomingMessage) =>
                !config.LOG_HTTP_REQUESTS || QUIET_PATHS.has(req.url ?? ''),
            },
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie'],
              censor: '[redacted]',
            },
            serializers: {
              req: (req: { id: string; method: string; url: string }) => ({
                id: req.id,
                method: req.method,
                url: req.url,
              }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
          },
        }),
        MetricsModule,
      ],
    };
  }
}
