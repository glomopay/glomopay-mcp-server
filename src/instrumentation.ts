import { startTelemetry } from '@/core/telemetry/telemetry.module';

// Imported first by the entrypoint so HTTP instrumentation is in place before any client loads.
startTelemetry();
