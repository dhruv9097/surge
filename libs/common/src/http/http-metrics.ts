import type { FastifyInstance } from 'fastify';
import { Gauge, Histogram } from 'prom-client';

const requestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status_code'],
  // Dense at the low end: the SLO is about p99 staying in tens of ms.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const inFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'HTTP requests currently being processed',
});

const startTimes = new WeakMap<object, bigint>();

/**
 * RED metrics per route. The route label is the route template
 * (`/events/:id`), never the raw URL, to keep label cardinality bounded.
 */
export function registerHttpMetrics(fastify: FastifyInstance) {
  fastify.addHook('onRequest', (req, _reply, done) => {
    startTimes.set(req, process.hrtime.bigint());
    inFlight.inc();
    done();
  });
  fastify.addHook('onResponse', (req, reply, done) => {
    inFlight.dec();
    const start = startTimes.get(req);
    const route = req.routeOptions.url ?? 'unmatched';
    if (start !== undefined && route !== '/metrics') {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      requestDuration.observe(
        { method: req.method, route, status_code: String(reply.statusCode) },
        seconds,
      );
    }
    done();
  });
}
