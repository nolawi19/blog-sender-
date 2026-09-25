import { destination, pino, stdTimeFunctions, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { LOG_REDACT_PATHS, redactSecrets } from '../security/redact.js';
import { serializeError } from '../errors.js';

export type { Logger } from 'pino';

export interface LoggerConfig {
  level: string;
  service: string;
  pretty?: boolean;
  /** Custom destination, used by tests to capture output. */
  destination?: DestinationStream;
}

function errorSerializer(err: unknown): Record<string, unknown> {
  const serialized = serializeError(err);
  const out: Record<string, unknown> = { ...serialized };
  if (err instanceof Error && err.stack) out['stack'] = redactSecrets(err.stack);
  return out;
}

/**
 * Structured JSON logger. In production, logs are written through an
 * asynchronous buffered destination so logging never blocks the hot path; call
 * `logger.flush()` during shutdown.
 */
export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: config.service, pid: process.pid },
    timestamp: stdTimeFunctions.isoTime,
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { err: errorSerializer, error: errorSerializer },
    formatters: { level: (label) => ({ level: label }) },
    // `redact` only covers structured fields; also scrub free-text messages so a
    // secret interpolated into a log string cannot leak.
    hooks: {
      logMethod(args, method) {
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (typeof arg === 'string') args[i] = redactSecrets(arg);
        }
        return method.apply(this, args);
      },
    },
  };

  if (config.destination) return pino(options, config.destination);

  if (config.pretty) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } },
    });
  }

  return pino(options, destination({ dest: 1, sync: false }));
}
