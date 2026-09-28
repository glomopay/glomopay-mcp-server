import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

export type TLogAttributes = Record<string, string | number | boolean | undefined>;
type TLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<TLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

const LOGGER_NAME = 'glomo-mcp-server';

function definedOnly(attributes: TLogAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * JSON-lines logger on stdout. Each line carries the active trace context, and the
 * same record goes to the OTel logs pipeline (a no-op unless telemetry is started).
 * Attribute names are camelCase.
 */
function write(level: TLevel, message: string, attributes: TLogAttributes = {}): void {
  const fields = definedOnly(attributes);
  const spanContext = trace.getSpanContext(context.active());
  const traceFields = spanContext && isSpanContextValid(spanContext) ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {};

  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...traceFields, ...fields })}\n`);

  logs.getLogger(LOGGER_NAME).emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes: fields,
    context: context.active(),
  });
}

export const logger = {
  debug: (message: string, attributes?: TLogAttributes) => write('debug', message, attributes),
  info: (message: string, attributes?: TLogAttributes) => write('info', message, attributes),
  warn: (message: string, attributes?: TLogAttributes) => write('warn', message, attributes),
  error: (message: string, attributes?: TLogAttributes) => write('error', message, attributes),
};
