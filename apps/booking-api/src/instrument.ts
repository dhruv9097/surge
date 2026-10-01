// Preloaded with `node --import` so tracing hooks are in place before any
// instrumented library is imported. Keep this file free of other imports.
import { startTelemetry } from '@surge/common/telemetry';

startTelemetry(process.env.SERVICE_NAME ?? 'booking-api');
