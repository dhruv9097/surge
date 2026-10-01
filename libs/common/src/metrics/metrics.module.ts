import { Controller, Get, Header, Module } from '@nestjs/common';
import { collectDefaultMetrics, register } from 'prom-client';

let defaultMetricsStarted = false;

/**
 * Registers Node runtime metrics (event loop lag, GC, heap, handles) once per
 * process. Event loop lag is the load-shedding signal for Node services, so it
 * is sampled at a finer resolution than the default.
 */
export function startDefaultMetrics(serviceName: string) {
  if (defaultMetricsStarted) return;
  defaultMetricsStarted = true;
  register.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ eventLoopMonitoringPrecision: 10 });
}

@Controller()
class MetricsController {
  // Scraped by Prometheus on the internal network; Nginx does not expose it.
  @Get('metrics')
  @Header('Content-Type', register.contentType)
  metrics() {
    return register.metrics();
  }
}

@Module({ controllers: [MetricsController] })
export class MetricsModule {}
