import { redactSecrets } from './security/redact.js';

export type ErrorCategory =
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'CONFIGURATION'
  | 'TEMPLATE'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'EXTERNAL_API'
  | 'REDIS'
  | 'DATABASE'
  | 'UNKNOWN';

export interface AppErrorOptions {
  code?: string;
  statusCode?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Base class for every error the engine raises on purpose. The `retryable` flag
 * is the single source of truth for whether the worker schedules another attempt.
 */
export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(category: ErrorCategory, message: string, options: AppErrorOptions = {}) {
    super(redactSecrets(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.category = category;
    this.code = options.code ?? category;
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details === undefined ? undefined : redactDetails(options.details);
  }
}

/** Details often echo upstream responses, which may contain tokens: scrub them once, here. */
function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(details))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('VALIDATION', message, { statusCode: 400, code: 'VALIDATION_FAILED', ...options, retryable: false });
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('AUTHENTICATION', message, { statusCode: 401, code: 'UNAUTHORIZED', ...options, retryable: false });
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('CONFIGURATION', message, { statusCode: 500, code: 'CONFIGURATION_ERROR', ...options, retryable: false });
  }
}

export class TemplateError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('TEMPLATE', message, { statusCode: 422, code: 'TEMPLATE_ERROR', ...options, retryable: false });
  }
}

export class NetworkError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('NETWORK', message, { statusCode: 502, code: 'NETWORK_ERROR', retryable: true, ...options });
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('TIMEOUT', message, { statusCode: 504, code: 'TIMEOUT', retryable: true, ...options });
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, retryAfterMs: number, options: AppErrorOptions = {}) {
    super('RATE_LIMIT', message, {
      statusCode: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      ...options,
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
    });
  }
}

export class ExternalApiError extends AppError {
  readonly httpStatus: number | undefined;
  constructor(message: string, httpStatus: number | undefined, options: AppErrorOptions = {}) {
    super('EXTERNAL_API', message, {
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      retryable: httpStatus === undefined || httpStatus >= 500,
      ...options,
    });
    this.httpStatus = httpStatus;
  }
}

export class RedisError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('REDIS', message, { statusCode: 503, code: 'REDIS_UNAVAILABLE', retryable: true, ...options });
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('DATABASE', message, { statusCode: 503, code: 'DATABASE_ERROR', retryable: true, ...options });
  }
}

export class UnknownError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    // Unknown failures are not retried automatically: they usually indicate a bug,
    // and the job lands in the dead-letter store where it can be requeued safely.
    super('UNKNOWN', message, { statusCode: 500, code: 'UNKNOWN_ERROR', ...options, retryable: false });
  }
}

/** Error codes raised by undici / Node sockets before any byte reached the server. */
const CONNECT_PHASE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const NETWORK_CODES = new Set([
  ...CONNECT_PHASE_CODES,
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
]);

const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

/** Prisma error codes that indicate a transient condition worth retrying. */
const RETRYABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}

/** True when the request provably never reached the remote server. */
export function isConnectPhaseError(err: unknown): boolean {
  if (err instanceof AppError) {
    const phaseCode = err.details?.['sourceCode'];
    return typeof phaseCode === 'string' && CONNECT_PHASE_CODES.has(phaseCode);
  }
  const code = errorCode(err);
  return code !== undefined && CONNECT_PHASE_CODES.has(code);
}

/** Maps any thrown value to an AppError with a category and a retry decision. */
export function classifyError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const name = errorName(err);
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'TimeoutError' || (name === 'AbortError' && /timeout/i.test(message))) {
    return new TimeoutError(`Operation timed out: ${message}`, { cause: err });
  }
  if (name === 'AbortError') {
    return new TimeoutError(`Operation aborted: ${message}`, { cause: err, code: 'ABORTED' });
  }
  if (name === 'ZodError') {
    return new ValidationError(`Validation failed: ${message}`, { cause: err });
  }
  if (code !== undefined && TIMEOUT_CODES.has(code)) {
    return new TimeoutError(`Request timed out (${code})`, { cause: err, details: { sourceCode: code } });
  }
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return new NetworkError(`Network error (${code}): ${message}`, { cause: err, details: { sourceCode: code } });
  }
  if (name.startsWith('PrismaClient')) {
    const retryable =
      name === 'PrismaClientInitializationError' ||
      name === 'PrismaClientRustPanicError' ||
      (code !== undefined && RETRYABLE_PRISMA_CODES.has(code));
    return new DatabaseError(`Database error${code ? ` (${code})` : ''}: ${message}`, {
      cause: err,
      retryable,
      details: code ? { prismaCode: code } : undefined,
    });
  }
  if (name === 'ReplyError' || name === 'MaxRetriesPerRequestError' || /redis/i.test(message)) {
    return new RedisError(`Redis error: ${message}`, { cause: err });
  }
  return new UnknownError(message || 'Unknown error', { cause: err });
}

export interface SerializedError {
  name: string;
  category: ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  /** Key and type of the workflow step that failed, when known. */
  failedStep?: string;
  failedStepType?: string;
  /** What happens next: another attempt, dead-letter store, or postponed (rate limit). */
  retryStatus?: 'retry_scheduled' | 'dead_lettered' | 'postponed_rate_limit';
}

/** JSON-safe, secret-free representation used for logs, execution rows and the DLQ. */
export function serializeError(err: unknown): SerializedError {
  const appError = classifyError(err);
  const out: SerializedError = {
    name: appError.name,
    category: appError.category,
    code: appError.code,
    message: redactSecrets(appError.message),
    retryable: appError.retryable,
  };
  if (appError.retryAfterMs !== undefined) out.retryAfterMs = appError.retryAfterMs;
  if (appError.details !== undefined) out.details = appError.details;
  return out;
}
