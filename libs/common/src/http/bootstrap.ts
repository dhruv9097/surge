import helmet from '@fastify/helmet';
import { type DynamicModule, Logger as NestLogger, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import type { BaseConfig } from '../config/config.js';
import { LifecycleService } from '../health/lifecycle.service.js';
import { shutdownTelemetry } from '../telemetry/index.js';
import { AllExceptionsFilter } from './exception.filter.js';
import { registerHttpMetrics } from './http-metrics.js';
import { requestIdFor } from './request-id.js';

export interface HttpAppOptions {
  /** Extra setup (global pipes, hooks) before the server starts listening. */
  configure?: (app: NestFastifyApplication) => void | Promise<void>;
}

/**
 * Creates a Fastify-backed Nest app with the production defaults every Surge
 * service shares: timeouts, body limits, security headers, RED metrics and a
 * uniform error shape. Does not listen; tests drive it with `inject()`.
 */
export async function createHttpApp(
  module: Type | DynamicModule,
  options: HttpAppOptions = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 64 * 1024,
    requestTimeout: 10_000,
    // Longer than Nginx's upstream keepalive_timeout, so the proxy always
    // closes idle connections first and never reuses one we already closed.
    keepAliveTimeout: 65_000,
    // Fastify would trust the header verbatim; requestIdFor validates it.
    requestIdHeader: false,
    genReqId: requestIdFor,
    return503OnClosing: true,
  });

  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.register(helmet, { contentSecurityPolicy: false });
  registerHttpMetrics(app.getHttpAdapter().getInstance());
  await options.configure?.(app);
  return app;
}

/** Creates the app, installs graceful shutdown and starts listening. */
export async function bootstrapHttpApp(
  module: Type | DynamicModule,
  config: BaseConfig,
  options: HttpAppOptions = {},
): Promise<NestFastifyApplication> {
  const app = await createHttpApp(module, options);
  installGracefulShutdown(app, config);
  await app.listen(config.PORT, config.HOST);
  return app;
}

/**
 * Shutdown order matters for zero-downtime deploys:
 *   1. fail readiness so the load balancer stops sending new requests
 *   2. wait for that to propagate
 *   3. close the server, letting in-flight requests finish
 *   4. close pools and flush telemetry (Nest shutdown hooks)
 * A hard timeout guarantees the process exits even if something hangs.
 */
function installGracefulShutdown(app: NestFastifyApplication, config: BaseConfig) {
  const logger = new NestLogger('Shutdown');
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`Received ${signal}, draining`);

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      app.get(LifecycleService).startDraining();
      await new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_DRAIN_DELAY_MS));
      await app.close();
      await shutdownTelemetry();
      logger.log('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
