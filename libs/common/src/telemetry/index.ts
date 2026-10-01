import { register } from 'node:module';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | undefined;

/**
 * Must run before any instrumented module (http, pg, ioredis, fastify) is
 * loaded, so each app preloads it with `node --import ./dist/instrument.js`.
 * This file deliberately imports nothing from Nest.
 *
 * Tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. Sampling is set
 * through the standard env vars (OTEL_TRACES_SAMPLER / _ARG), since tracing
 * every request during a 10k rps spike would cost more than it tells you.
 */
export function startTelemetry(serviceName: string) {
  if (sdk || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  // Nest 12 is ESM-only. require() hooks alone cannot patch ES modules, so
  // install the ESM loader hook as well before the app graph is imported.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // High-volume, low-value spans.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownTelemetry() {
  await sdk?.shutdown().catch(() => undefined);
}
