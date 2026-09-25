import { Pool } from 'undici';
import { z } from 'zod';
import {
  AppError,
  classifyError,
  ConfigurationError,
  ExternalApiError,
  isConnectPhaseError,
  NetworkError,
  RateLimitError,
  TimeoutError,
} from '../../errors.js';
import { TokenBucketLimiter } from '../../lib/rate-limiter.js';
import { retryAsync, sleep, type BackoffPolicy } from '../../lib/retry.js';
import type { Logger } from '../../observability/logger.js';
import { defineAction, type ActionContext, type IntegrationDriver } from '../integration-driver.js';

// ---------------------------------------------------------------------------
// Telegram Bot API types (subset)
// ---------------------------------------------------------------------------

export type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';

export interface SendMessageParams {
  chatId: string | number;
  text: string;
  parseMode?: ParseMode | undefined;
  disableNotification?: boolean | undefined;
  disableWebPagePreview?: boolean | undefined;
  protectContent?: boolean | undefined;
  messageThreadId?: number | undefined;
  replyMarkup?: Record<string, unknown> | undefined;
}

export interface SendPhotoParams {
  chatId: string | number;
  /** HTTPS URL (Telegram downloads it) or a file_id. */
  photo: string;
  caption?: string | undefined;
  parseMode?: ParseMode | undefined;
  disableNotification?: boolean | undefined;
  protectContent?: boolean | undefined;
  messageThreadId?: number | undefined;
  hasSpoiler?: boolean | undefined;
  replyMarkup?: Record<string, unknown> | undefined;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string };
  text?: string;
  caption?: string;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramMigrateError extends ExternalApiError {
  constructor(
    readonly method: string,
    readonly migrateToChatId: number,
  ) {
    super(`Telegram ${method}: group was migrated to a supergroup`, 400, {
      code: 'TELEGRAM_CHAT_MIGRATED',
      retryable: false,
      details: { method, migrateToChatId },
    });
  }
}

// Photo download failures on Telegram's side are usually transient.
const TRANSIENT_400 = /failed to get HTTP URL content|wrong type of the web page content|WEBPAGE_CURL_FAILED|WEBPAGE_MEDIA_EMPTY/i;

/** Maps a Telegram error envelope to a classified AppError. */
export function toTelegramError(method: string, httpStatus: number, envelope: TelegramEnvelope<unknown> | null): AppError {
  const code = envelope?.error_code ?? httpStatus;
  const description = (envelope?.description ?? `HTTP ${httpStatus}`).slice(0, 500);
  const details = { method, errorCode: code, description };

  if (code === 429) {
    const retryAfterSec = envelope?.parameters?.retry_after ?? 1;
    return new RateLimitError(`Telegram ${method} rate limited: ${description}`, retryAfterSec * 1000, { code: 'TELEGRAM_RATE_LIMITED', details });
  }
  const migrateTo = envelope?.parameters?.migrate_to_chat_id;
  if (migrateTo !== undefined) return new TelegramMigrateError(method, migrateTo);
  if (code === 401 || code === 404) {
    return new ConfigurationError(`Telegram ${method} rejected the bot token (${code} ${description})`, { code: 'TELEGRAM_UNAUTHORIZED', details });
  }
  if (code === 403) {
    return new ExternalApiError(`Telegram ${method} forbidden: ${description}`, 403, { code: 'TELEGRAM_FORBIDDEN', retryable: false, details });
  }
  if (code >= 500 || httpStatus >= 500) {
    return new ExternalApiError(`Telegram ${method} server error: ${description}`, httpStatus, { code: 'TELEGRAM_SERVER_ERROR', retryable: true, details });
  }
  if (code === 400 && TRANSIENT_400.test(description)) {
    return new ExternalApiError(`Telegram ${method} could not fetch media: ${description}`, 400, { code: 'TELEGRAM_MEDIA_FETCH_FAILED', retryable: true, details });
  }
  return new ExternalApiError(`Telegram ${method} rejected the request: ${description}`, httpStatus, {
    code: 'TELEGRAM_BAD_REQUEST',
    retryable: false,
    details,
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TelegramClientOptions {
  baseUrl: string;
  timeoutMs: number;
  connections: number;
  keepAliveTimeoutMs: number;
  inlineRetries: number;
  inlineBackoff?: BackoffPolicy;
  rateLimit: { globalPerSec: number; perChatPerSec: number; perChatBurst: number; maxWaitMs: number };
  warmupConnections: number;
  keepWarmIntervalMs: number;
  logger: Logger;
}

export interface TelegramCallOptions {
  signal?: AbortSignal | undefined;
  onRequestStart?: (() => void) | undefined;
  onResponse?: (() => void) | undefined;
}

function botIdOf(token: string): string {
  const idx = token.indexOf(':');
  return idx > 0 ? token.slice(0, idx) : 'unknown';
}

function compact(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Low-level Telegram Bot API client.
 *
 * - One undici Pool per API origin with HTTP keep-alive, so steady-state calls
 *   reuse warm TLS connections (no TCP/TLS handshake on the hot path).
 * - Optional warm-up and periodic keep-warm requests keep sockets open during
 *   quiet periods.
 * - Client-side token buckets (per bot, per chat) respect Telegram's limits; if
 *   the wait would be long, a RateLimitError is thrown so the job is delayed
 *   instead of holding a worker slot.
 * - Inline retries only for failures where the request provably did not reach
 *   Telegram (connect errors), 5xx, or short Retry-After values. Everything else
 *   is surfaced to the queue, which retries with backoff.
 * - The bot token only ever appears in the request path; it is never logged and
 *   error messages are redacted.
 */
export class TelegramClient {
  private readonly pool: Pool;
  private readonly globalLimiter: TokenBucketLimiter;
  private readonly chatLimiter: TokenBucketLimiter;
  private readonly inlineBackoff: BackoffPolicy;
  private keepWarmTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: TelegramClientOptions) {
    const origin = new URL(options.baseUrl).origin;
    this.pool = new Pool(origin, {
      connections: options.connections,
      pipelining: 1,
      keepAliveTimeout: options.keepAliveTimeoutMs,
      keepAliveMaxTimeout: options.keepAliveTimeoutMs * 10,
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
      connect: { timeout: Math.min(options.timeoutMs, 5_000), keepAlive: true, noDelay: true },
    });
    this.globalLimiter = new TokenBucketLimiter({
      ratePerSec: options.rateLimit.globalPerSec,
      burst: Math.max(1, Math.ceil(options.rateLimit.globalPerSec)),
    });
    this.chatLimiter = new TokenBucketLimiter({
      ratePerSec: options.rateLimit.perChatPerSec,
      burst: options.rateLimit.perChatBurst,
    });
    this.inlineBackoff = options.inlineBackoff ?? { baseDelayMs: 100, maxDelayMs: 1_000 };
  }

  sendMessage(token: string, params: SendMessageParams, opts: TelegramCallOptions = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>(
      token,
      'sendMessage',
      compact({
        chat_id: params.chatId,
        text: params.text,
        parse_mode: params.parseMode,
        disable_notification: params.disableNotification,
        protect_content: params.protectContent,
        message_thread_id: params.messageThreadId,
        link_preview_options: params.disableWebPagePreview === undefined ? undefined : { is_disabled: params.disableWebPagePreview },
        reply_markup: params.replyMarkup,
      }),
      opts,
    );
  }

  sendPhoto(token: string, params: SendPhotoParams, opts: TelegramCallOptions = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>(
      token,
      'sendPhoto',
      compact({
        chat_id: params.chatId,
        photo: params.photo,
        caption: params.caption,
        parse_mode: params.caption === undefined ? undefined : params.parseMode,
        disable_notification: params.disableNotification,
        protect_content: params.protectContent,
        message_thread_id: params.messageThreadId,
        has_spoiler: params.hasSpoiler,
        reply_markup: params.replyMarkup,
      }),
      opts,
    );
  }

  /** Calls any Bot API method with rate limiting, inline retries and chat-migration handling. */
  async call<T>(token: string, method: string, payload: Record<string, unknown>, opts: TelegramCallOptions = {}): Promise<T> {
    try {
      return await this.callWithRetries<T>(token, method, payload, opts);
    } catch (err) {
      if (err instanceof TelegramMigrateError && payload['chat_id'] !== err.migrateToChatId) {
        this.options.logger.warn({ method, migrateToChatId: err.migrateToChatId }, 'telegram chat migrated; retrying with the new chat id (update the workflow)');
        return this.callWithRetries<T>(token, method, { ...payload, chat_id: err.migrateToChatId }, opts);
      }
      throw err;
    }
  }

  private async callWithRetries<T>(token: string, method: string, payload: Record<string, unknown>, opts: TelegramCallOptions): Promise<T> {
    return retryAsync((attempt) => this.callOnce<T>(token, method, payload, opts, attempt), {
      retries: this.options.inlineRetries,
      policy: this.inlineBackoff,
      signal: opts.signal,
      shouldRetry: (err) => this.isSafeToRetryInline(err),
      onRetry: (err, retryNumber, delayMs) =>
        this.options.logger.warn({ method, retryNumber, delayMs, err }, 'telegram call failed, retrying inline'),
    });
  }

  private isSafeToRetryInline(err: AppError): boolean {
    if (err instanceof RateLimitError) return (err.retryAfterMs ?? Infinity) <= this.options.rateLimit.maxWaitMs;
    if (err instanceof NetworkError || err instanceof TimeoutError) return isConnectPhaseError(err);
    if (err instanceof ExternalApiError) return err.retryable && (err.httpStatus ?? 0) >= 500;
    return false;
  }

  private async acquireRateLimit(token: string, chatId: unknown, signal: AbortSignal | undefined): Promise<void> {
    const botKey = botIdOf(token);
    const maxWait = this.options.rateLimit.maxWaitMs;
    const global = this.globalLimiter.reserve(botKey, maxWait);
    if (!global.ok) throw new RateLimitError('Telegram bot-wide rate limit reached (client side)', global.retryAfterMs, { code: 'TELEGRAM_CLIENT_RATE_LIMIT' });
    let wait = global.waitMs;
    if (chatId !== undefined) {
      const chatKey = `${botKey}:${String(chatId)}`;
      const chat = this.chatLimiter.reserve(chatKey, maxWait);
      if (!chat.ok) {
        this.globalLimiter.release(botKey);
        throw new RateLimitError('Telegram per-chat rate limit reached (client side)', chat.retryAfterMs, { code: 'TELEGRAM_CLIENT_RATE_LIMIT' });
      }
      wait = Math.max(wait, chat.waitMs);
    }
    if (wait > 0) await sleep(wait, signal);
  }

  private async callOnce<T>(token: string, method: string, payload: Record<string, unknown>, opts: TelegramCallOptions, attempt: number): Promise<T> {
    if (attempt === 1) await this.acquireRateLimit(token, payload['chat_id'], opts.signal);
    opts.onRequestStart?.();
    let response: Awaited<ReturnType<Pool['request']>>;
    try {
      response = await this.pool.request({
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal ?? null,
      });
    } catch (err) {
      throw classifyError(opts.signal?.aborted && opts.signal.reason !== undefined ? opts.signal.reason : err);
    }
    opts.onResponse?.();

    let envelope: TelegramEnvelope<T> | null = null;
    try {
      envelope = (await response.body.json()) as TelegramEnvelope<T>;
    } catch (err) {
      if (opts.signal?.aborted) throw classifyError(opts.signal.reason ?? err);
      envelope = null;
    }
    if (response.statusCode === 200 && envelope?.ok && envelope.result !== undefined) return envelope.result;
    throw toTelegramError(method, response.statusCode, envelope);
  }

  /** Opens up to `warmupConnections` keep-alive sockets ahead of the first real call. */
  async warmUp(): Promise<void> {
    const n = this.options.warmupConnections;
    if (n <= 0) return;
    const started = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: n }, async () => {
        // GET, not HEAD: undici closes the socket after a HEAD response, which
        // would defeat the purpose of warming the pool.
        const res = await this.pool.request({ path: '/', method: 'GET', signal: AbortSignal.timeout(this.options.timeoutMs) });
        await res.body.dump();
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    this.options.logger.info({ connections: n, failed, ms: Math.round(performance.now() - started) }, 'telegram connection pool warmed');
  }

  startKeepWarm(): void {
    if (this.options.keepWarmIntervalMs <= 0 || this.keepWarmTimer) return;
    this.keepWarmTimer = setInterval(() => {
      this.warmUp().catch(() => undefined);
    }, this.options.keepWarmIntervalMs);
    this.keepWarmTimer.unref();
  }

  async close(): Promise<void> {
    if (this.keepWarmTimer) clearInterval(this.keepWarmTimer);
    this.keepWarmTimer = null;
    await Promise.race([this.pool.close(), sleep(5_000)]);
    if (!this.pool.closed) await this.pool.destroy();
  }
}

// ---------------------------------------------------------------------------
// Workflow actions
// ---------------------------------------------------------------------------

const chatIdSchema = z.union([z.number().int(), z.string().trim().min(1).max(64)]);
const parseModeSchema = z.enum(['HTML', 'MarkdownV2', 'Markdown']);
const replyMarkupSchema = z.record(z.string(), z.unknown());

export const sendMessageConfigSchema = z.object({
  chatId: chatIdSchema,
  text: z.string().min(1, 'text must not be empty').max(16_384),
  parseMode: parseModeSchema.optional(),
  disableNotification: z.boolean().optional(),
  disableWebPagePreview: z.boolean().optional(),
  protectContent: z.boolean().optional(),
  messageThreadId: z.number().int().optional(),
  replyMarkup: replyMarkupSchema.optional(),
});

export const sendPhotoConfigSchema = z.object({
  chatId: chatIdSchema,
  photo: z.string().trim().min(1, 'photo must not be empty').max(2_048),
  caption: z.string().max(8_192).optional(),
  parseMode: parseModeSchema.optional(),
  disableNotification: z.boolean().optional(),
  protectContent: z.boolean().optional(),
  messageThreadId: z.number().int().optional(),
  hasSpoiler: z.boolean().optional(),
  replyMarkup: replyMarkupSchema.optional(),
});

function botTokenFor(context: ActionContext, fallback: string | undefined): string {
  const fromCredential = context.credential?.data['botToken'];
  if (typeof fromCredential === 'string' && fromCredential.length > 0) return fromCredential;
  if (fallback) return fallback;
  throw new ConfigurationError('No Telegram bot token: attach a "telegram" credential to the step or set TELEGRAM_BOT_TOKEN', {
    code: 'TELEGRAM_TOKEN_MISSING',
  });
}

function messageOutput(message: TelegramMessage): Record<string, unknown> {
  return { messageId: message.message_id, chatId: message.chat.id, date: message.date };
}

export function createTelegramDriver(client: TelegramClient, options: { defaultBotToken?: string | undefined } = {}): IntegrationDriver {
  const callOptions = (context: ActionContext): TelegramCallOptions => ({
    signal: context.signal,
    onRequestStart: context.markRequestStart,
    onResponse: context.markResponse,
  });

  return {
    name: 'telegram',
    actions: [
      defineAction({
        type: 'telegram.sendMessage',
        configSchema: sendMessageConfigSchema,
        credentialProvider: 'telegram',
        async execute(config, context) {
          const message = await client.sendMessage(botTokenFor(context, options.defaultBotToken), config, callOptions(context));
          return { output: messageOutput(message) };
        },
      }),
      defineAction({
        type: 'telegram.sendPhoto',
        configSchema: sendPhotoConfigSchema,
        credentialProvider: 'telegram',
        async execute(config, context) {
          const message = await client.sendPhoto(botTokenFor(context, options.defaultBotToken), config, callOptions(context));
          return { output: messageOutput(message) };
        },
      }),
    ],
    async init() {
      await client.warmUp();
      client.startKeepWarm();
    },
    close: () => client.close(),
  };
}
