import { z } from 'zod';

const boolFromEnv = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);

/**
 * Accepts a 32-byte key as 64 hex characters or as base64 / base64url.
 * Generate one with: openssl rand -hex 32
 */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const decoded = Buffer.from(trimmed, /[-_]/.test(trimmed) ? 'base64url' : 'base64');
  if (decoded.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (use: openssl rand -hex 32)');
  }
  return decoded;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(1, 65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_SIZE: int(1, 200).default(10),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  WORKER_CONCURRENCY: int(1, 10_000).default(50),
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 characters'),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required'),
  ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9]{1,16}$/).default('v1'),
  TELEGRAM_BOT_TOKEN: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  /**
   * Default destination for Telegram steps without a chatId: a channel username
   * (@yourchannel) or a numeric channel ID (-100…). Personal chat IDs are rejected.
   */
  TELEGRAM_CHANNEL_ID: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v) || /^-100\d{5,15}$/.test(v), {
      message: 'must be a channel username like @yourchannel or a channel ID starting with -100',
    }),
  TELEGRAM_API_BASE_URL: z.url().default('https://api.telegram.org'),
  TELEGRAM_POOL_CONNECTIONS: int(1, 1024).default(32),
  TELEGRAM_WARMUP_CONNECTIONS: int(0, 1024).default(4),
  TELEGRAM_KEEP_WARM_INTERVAL_MS: int(0).default(25_000),
  TELEGRAM_INLINE_RETRIES: int(0, 5).default(1),
  TELEGRAM_RATE_LIMIT_GLOBAL_PER_SEC: z.coerce.number().positive().default(30),
  TELEGRAM_RATE_LIMIT_PER_CHAT_PER_SEC: z.coerce.number().positive().default(1),
  TELEGRAM_RATE_LIMIT_PER_CHAT_BURST: int(1).default(3),
  TELEGRAM_RATE_LIMIT_MAX_WAIT_MS: int(0).default(50),
  HTTP_TIMEOUT_MS: int(100).default(10_000),
  HTTP_KEEPALIVE_TIMEOUT_MS: int(1_000).default(60_000),
  HTTP_ALLOW_PRIVATE_NETWORKS: boolFromEnv.default(false),
  STEP_TIMEOUT_MS: int(100).default(15_000),
  JOB_TIMEOUT_MS: int(100).default(60_000),
  MAX_RETRIES: int(0, 50).default(5),
  JOB_RATE_LIMIT_MAX_DEFER_MS: int(0).default(3_600_000),
  RETRY_BASE_DELAY_MS: int(1).default(1_000),
  RETRY_MAX_DELAY_MS: int(1).default(300_000),
  WEBHOOK_BODY_LIMIT_BYTES: int(1_024, 50 * 1024 * 1024).default(262_144),
  WEBHOOK_HMAC_TOLERANCE_SEC: int(1).default(300),
  WEBHOOK_FORWARD_SENSITIVE_HEADERS: boolFromEnv.default(false),
  RATE_LIMIT_ENABLED: boolFromEnv.default(true),
  RATE_LIMIT_MAX: int(1).default(1_000),
  RATE_LIMIT_WINDOW_MS: int(100).default(1_000),
  IDEMPOTENCY_TTL_SEC: int(1).default(86_400),
  /** Also consult the idempotency_keys table when Redis no longer has the key. */
  IDEMPOTENCY_DURABLE: boolFromEnv.default(true),
  QUEUE_BACKPRESSURE_THRESHOLD: int(1).default(100_000),
  CACHE_REFRESH_INTERVAL_MS: int(1_000).default(30_000),
  RECORDER_FLUSH_INTERVAL_MS: int(10).default(200),
  RECORDER_MAX_BUFFER: int(100).default(20_000),
  STORE_TRIGGER_PAYLOAD: boolFromEnv.default(true),
  WORKER_METRICS_PORT: int(0, 65535).default(9464),
  TRUST_PROXY: boolFromEnv.default(false),
  SHUTDOWN_TIMEOUT_MS: int(1_000).default(25_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: boolFromEnv.default(false),
});

export type RawConfig = z.infer<typeof envSchema>;

export interface Config extends RawConfig {
  encryptionKey: Buffer;
  isProduction: boolean;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  let encryptionKey: Buffer;
  try {
    encryptionKey = parseEncryptionKey(parsed.data.ENCRYPTION_KEY);
  } catch (err) {
    throw new ConfigError([`ENCRYPTION_KEY: ${(err as Error).message}`]);
  }
  if (parsed.data.RETRY_MAX_DELAY_MS < parsed.data.RETRY_BASE_DELAY_MS) {
    throw new ConfigError(['RETRY_MAX_DELAY_MS must be >= RETRY_BASE_DELAY_MS']);
  }
  return {
    ...parsed.data,
    encryptionKey,
    isProduction: parsed.data.NODE_ENV === 'production',
  };
}
