import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError, ExternalApiError, RateLimitError, TimeoutError } from '../src/errors.js';
import type { ActionContext } from '../src/integrations/integration-driver.js';
import { createTelegramDriver, TelegramClient, toTelegramError, type TelegramClientOptions } from '../src/integrations/telegram/telegram-driver.js';
import { BOT_TOKEN, capturingLogger, silentLogger } from './helpers/fixtures.js';
import { json, startTestServer, telegramOk, type TestServer } from './helpers/http-server.js';

let server: TestServer;
let client: TelegramClient | null = null;

function makeClient(overrides: Partial<TelegramClientOptions> = {}): TelegramClient {
  client = new TelegramClient({
    baseUrl: server.url,
    timeoutMs: 2_000,
    connections: 4,
    keepAliveTimeoutMs: 30_000,
    inlineRetries: 1,
    inlineBackoff: { baseDelayMs: 5, maxDelayMs: 10 },
    rateLimit: { globalPerSec: 1_000, perChatPerSec: 1_000, perChatBurst: 1_000, maxWaitMs: 50 },
    warmupConnections: 0,
    keepWarmIntervalMs: 0,
    logger: silentLogger(),
    ...overrides,
  });
  return client;
}

beforeEach(async () => {
  server = await startTestServer((req, res) => telegramOk(res, req.json?.['chat_id'] as number));
});

afterEach(async () => {
  await client?.close();
  client = null;
  await server.close();
});

describe('TelegramClient requests', () => {
  it('sends sendPhoto with snake_case fields to /bot<token>/sendPhoto', async () => {
    const tg = makeClient();
    const message = await tg.sendPhoto(BOT_TOKEN, { chatId: 42, photo: 'https://example.com/a.jpg', caption: 'Hi', parseMode: 'HTML', hasSpoiler: true });
    expect(message.message_id).toBe(1);
    const req = server.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`/bot${BOT_TOKEN}/sendPhoto`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.json).toEqual({ chat_id: 42, photo: 'https://example.com/a.jpg', caption: 'Hi', parse_mode: 'HTML', has_spoiler: true });
  });

  it('sends sendMessage and maps disableWebPagePreview to link_preview_options', async () => {
    const tg = makeClient();
    await tg.sendMessage(BOT_TOKEN, { chatId: '@channel', text: 'Hello', disableWebPagePreview: true, disableNotification: true });
    expect(server.requests[0]!.url).toBe(`/bot${BOT_TOKEN}/sendMessage`);
    expect(server.requests[0]!.json).toEqual({ chat_id: '@channel', text: 'Hello', disable_notification: true, link_preview_options: { is_disabled: true } });
  });

  it('reuses keep-alive connections across calls (connection pooling)', async () => {
    const tg = makeClient();
    for (let i = 0; i < 20; i++) await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: `m${i}` });
    expect(server.requests).toHaveLength(20);
    // undici may open a second socket while the first is still finishing a
    // response body; after that every request reuses a warm connection.
    expect(server.connections).toBeLessThanOrEqual(2);
  });

  it('pre-warms pooled connections so the first real call needs no handshake', async () => {
    const tg = makeClient({ warmupConnections: 3 });
    await tg.warmUp();
    const warmed = server.connections;
    expect(warmed).toBeGreaterThanOrEqual(3);
    await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: 'after warm-up' });
    expect(server.connections).toBe(warmed);
  });

  it('reports request start and response through callbacks', async () => {
    const tg = makeClient();
    const marks: string[] = [];
    await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: 'x' }, { onRequestStart: () => marks.push('start'), onResponse: () => marks.push('response') });
    expect(marks).toEqual(['start', 'response']);
  });
});

describe('TelegramClient error classification', () => {
  it('maps 429 to a RateLimitError honouring retry_after', async () => {
    server.setHandler((_req, res) => json(res, 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }));
    const tg = makeClient();
    const err = await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(7_000);
    expect((err as RateLimitError).retryable).toBe(true);
    // retry_after (7 s) exceeds the inline wait budget, so no inline retry happened.
    expect(server.requests).toHaveLength(1);
  });

  it('retries 5xx inline with backoff and then succeeds', async () => {
    let calls = 0;
    server.setHandler((req, res) => (++calls === 1 ? json(res, 502, { ok: false, error_code: 502, description: 'Bad Gateway' }) : telegramOk(res, req.json?.['chat_id'] as number)));
    const tg = makeClient();
    const message = await tg.sendMessage(BOT_TOKEN, { chatId: 5, text: 'x' });
    expect(message.chat.id).toBe(5);
    expect(server.requests).toHaveLength(2);
  });

  it('gives up after the inline retry budget and surfaces a retryable error', async () => {
    server.setHandler((_req, res) => json(res, 500, { ok: false, error_code: 500, description: 'Internal' }));
    const tg = makeClient({ inlineRetries: 2 });
    const err = await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect((err as ExternalApiError).retryable).toBe(true);
    expect(server.requests).toHaveLength(3);
  });

  it('does not retry 400 Bad Request', async () => {
    server.setHandler((_req, res) => json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    const tg = makeClient();
    const err = await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect((err as ExternalApiError).retryable).toBe(false);
    expect((err as ExternalApiError).code).toBe('TELEGRAM_BAD_REQUEST');
    expect(server.requests).toHaveLength(1);
  });

  it('treats invalid tokens (401/404) as configuration errors', async () => {
    server.setHandler((_req, res) => json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' }));
    const err = await makeClient().sendMessage(BOT_TOKEN, { chatId: 1, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).retryable).toBe(false);
  });

  it('classifies envelopes consistently', () => {
    expect(toTelegramError('sendMessage', 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }).retryable).toBe(false);
    expect(toTelegramError('sendPhoto', 400, { ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' }).retryable).toBe(true);
    expect(toTelegramError('sendPhoto', 400, { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' }).retryable).toBe(false);
    expect(toTelegramError('sendMessage', 503, null).retryable).toBe(true);
  });

  it('retries once against the new chat id after a supergroup migration', async () => {
    server.setHandler((req, res) =>
      req.json?.['chat_id'] === -100
        ? json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -1009999 } })
        : telegramOk(res, req.json?.['chat_id'] as number),
    );
    const message = await makeClient().sendMessage(BOT_TOKEN, { chatId: -100, text: 'x' });
    expect(message.chat.id).toBe(-1009999);
    expect(server.requests.map((r) => r.json?.['chat_id'])).toEqual([-100, -1009999]);
  });
});

describe('TelegramClient timeouts and rate limits', () => {
  it('times out slow responses with a retryable TimeoutError', async () => {
    server.setHandler((_req, res) => {
      setTimeout(() => telegramOk(res), 1_000);
    });
    const tg = makeClient({ inlineRetries: 0 });
    const started = performance.now();
    const err = await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: 'x' }, { signal: AbortSignal.timeout(100) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).retryable).toBe(true);
    expect(performance.now() - started).toBeLessThan(900);
  });

  it('applies the configured HTTP timeout even without a caller signal', async () => {
    server.setHandler((_req, res) => {
      setTimeout(() => telegramOk(res), 1_500);
    });
    const tg = makeClient({ timeoutMs: 150, inlineRetries: 0 });
    const err = await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('throttles per chat and asks the queue to reschedule when the wait is too long', async () => {
    const tg = makeClient({ rateLimit: { globalPerSec: 1_000, perChatPerSec: 1, perChatBurst: 1, maxWaitMs: 50 } });
    await tg.sendMessage(BOT_TOKEN, { chatId: 7, text: 'first' });
    const err = await tg.sendMessage(BOT_TOKEN, { chatId: 7, text: 'second' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBeGreaterThan(900);
    // A different chat is unaffected.
    await expect(tg.sendMessage(BOT_TOKEN, { chatId: 8, text: 'other chat' })).resolves.toBeDefined();
    expect(server.requests).toHaveLength(2);
  });

  it('waits in-process when the throttle delay is short', async () => {
    const tg = makeClient({ rateLimit: { globalPerSec: 1_000, perChatPerSec: 20, perChatBurst: 1, maxWaitMs: 200 } });
    await tg.sendMessage(BOT_TOKEN, { chatId: 9, text: 'a' });
    const started = performance.now();
    await tg.sendMessage(BOT_TOKEN, { chatId: 9, text: 'b' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });
});

describe('Telegram driver and secret handling', () => {
  function actionContext(overrides: Partial<ActionContext> = {}): ActionContext {
    return {
      signal: AbortSignal.timeout(2_000),
      logger: silentLogger(),
      credential: { id: 'c1', name: 'bot', provider: 'telegram', data: { botToken: BOT_TOKEN } },
      executionId: 'e1',
      workflowId: 'w1',
      stepId: 's1',
      stepKey: 'announce',
      attempt: 1,
      markRequestStart: () => undefined,
      markResponse: () => undefined,
      ...overrides,
    };
  }

  it('executes telegram.sendPhoto with the credential token and returns message output', async () => {
    const driver = createTelegramDriver(makeClient());
    const action = driver.actions.find((a) => a.type === 'telegram.sendPhoto')!;
    const result = await action.run({ chatId: '42', photo: 'https://example.com/a.jpg', caption: 'Hi' }, actionContext());
    expect(result.output).toEqual({ messageId: 1, chatId: 42, date: 1_700_000_000 });
    expect(server.requests[0]!.url).toBe(`/bot${BOT_TOKEN}/sendPhoto`);
  });

  it('falls back to TELEGRAM_BOT_TOKEN and fails clearly when no token exists', async () => {
    const fallback = '999999:BBEhBOweik6ad9r_QXMENQjcrGbqCr4K-rb';
    const withFallback = createTelegramDriver(makeClient(), { defaultBotToken: fallback });
    await withFallback.actions[0]!.run({ chatId: 1, text: 'x' }, actionContext({ credential: null }));
    expect(server.requests[0]!.url).toBe(`/bot${fallback}/sendMessage`);

    const noToken = createTelegramDriver(makeClient());
    await expect(noToken.actions[0]!.run({ chatId: 1, text: 'x' }, actionContext({ credential: null }))).rejects.toThrow(/No Telegram bot token/);
  });

  it('rejects invalid rendered configuration as a non-retryable configuration error', async () => {
    const driver = createTelegramDriver(makeClient());
    const sendPhoto = driver.actions.find((a) => a.type === 'telegram.sendPhoto')!;
    const err = await sendPhoto.run({ chatId: '42', caption: 'no photo' }, actionContext()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).code).toBe('STEP_CONFIG_INVALID');
    expect(server.requests).toHaveLength(0);
  });

  it('never exposes the bot token in errors or logs', async () => {
    const { logger, lines } = capturingLogger();
    server.setHandler((_req, res) => json(res, 500, { ok: false, error_code: 500, description: `upstream failed for bot${BOT_TOKEN}` }));
    const tg = makeClient({ logger, inlineRetries: 1 });
    const err = (await tg.sendMessage(BOT_TOKEN, { chatId: 1, text: 'x' }).catch((e: unknown) => e)) as Error;
    logger.error({ err, botToken: BOT_TOKEN, nested: { token: BOT_TOKEN } }, `failed with ${BOT_TOKEN}`);
    logger.flush();
    expect(err.message).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(err)).not.toContain(BOT_TOKEN);
    const output = lines().join('\n');
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(BOT_TOKEN);
  });
});

describe('Telegram channel destination and photo fallback', () => {
  const CHANNEL = '@automation_test_channel';
  function ctx(): ActionContext {
    return {
      signal: AbortSignal.timeout(2_000),
      logger: silentLogger(),
      credential: null,
      executionId: 'e1',
      workflowId: 'w1',
      stepId: 's1',
      stepKey: 'announce',
      attempt: 1,
      markRequestStart: () => undefined,
      markResponse: () => undefined,
    };
  }
  const driver = () => createTelegramDriver(makeClient(), { defaultBotToken: BOT_TOKEN, defaultChatId: CHANNEL });
  const action = (type: string) => driver().actions.find((a) => a.type === type)!;

  it('sends to TELEGRAM_CHANNEL_ID when the step has no chatId', async () => {
    await action('telegram.sendMessage').run({ text: 'hello' }, ctx());
    expect(server.requests[0]!.json?.['chat_id']).toBe(CHANNEL);
  });

  it('treats an empty chatId as "use the channel" instead of failing validation', async () => {
    await action('telegram.sendPhoto').run({ chatId: '', photo: 'https://example.com/a.jpg', caption: 'c' }, ctx());
    expect(server.requests[0]!.json?.['chat_id']).toBe(CHANNEL);
  });

  it('an explicit chatId still wins over the channel default', async () => {
    await action('telegram.sendMessage').run({ chatId: '@other_channel', text: 'x' }, ctx());
    expect(server.requests[0]!.json?.['chat_id']).toBe('@other_channel');
  });

  it('fails clearly (by variable name) when no destination is configured', async () => {
    const noChannel = createTelegramDriver(makeClient(), { defaultBotToken: BOT_TOKEN });
    const err = await noChannel.actions[0]!.run({ text: 'x' }, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).code).toBe('TELEGRAM_CHAT_MISSING');
    expect((err as Error).message).toContain('TELEGRAM_CHANNEL_ID');
    expect(server.requests).toHaveLength(0);
  });

  it('with fallbackToMessage, an empty photo sends the caption as text and never calls sendPhoto', async () => {
    const result = await action('telegram.sendPhoto').run({ photo: '', caption: '<b>Title</b>', parseMode: 'HTML', fallbackToMessage: true }, ctx());
    expect(server.requests.map((r) => r.url.split('/').pop())).toEqual(['sendMessage']);
    expect(server.requests[0]!.json).toMatchObject({ chat_id: CHANNEL, text: '<b>Title</b>', parse_mode: 'HTML' });
    expect(result.output).toMatchObject({ fallback: 'sendMessage', fallbackReason: 'missing_photo' });
  });

  it.each(['Bad Request: failed to get HTTP URL content', 'Bad Request: wrong file identifier/HTTP URL specified', 'Bad Request: wrong type of the web page content', 'Bad Request: message caption is too long'])(
    'with fallbackToMessage, Telegram "%s" falls back to sendMessage',
    async (description) => {
      server.setHandler((req, res) =>
        req.url.endsWith('/sendPhoto') ? json(res, 400, { ok: false, error_code: 400, description }) : telegramOk(res, -1001234567890),
      );
      const result = await action('telegram.sendPhoto').run({ photo: 'https://example.com/a.jpg', caption: 'Title', fallbackToMessage: true }, ctx());
      expect(server.requests.map((r) => r.url.split('/').pop())).toEqual(['sendPhoto', 'sendMessage']);
      expect(result.output).toMatchObject({ fallback: 'sendMessage' });
    },
  );

  it('does not hide unrelated errors behind the fallback (e.g. chat not found)', async () => {
    server.setHandler((_req, res) => json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    const err = await action('telegram.sendPhoto').run({ photo: 'https://example.com/a.jpg', caption: 'Title', fallbackToMessage: true }, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect(server.requests).toHaveLength(1);
  });

  it('without fallbackToMessage the original validation is unchanged', async () => {
    const err = await action('telegram.sendPhoto').run({ photo: '', caption: 'x' }, ctx()).catch((e: unknown) => e);
    expect((err as ConfigurationError).code).toBe('STEP_CONFIG_INVALID');
    expect(JSON.stringify((err as ConfigurationError).details)).toContain('photo must not be empty');
    const noCaption = await action('telegram.sendPhoto').run({ photo: '', fallbackToMessage: true }, ctx()).catch((e: unknown) => e);
    expect(JSON.stringify((noCaption as ConfigurationError).details)).toContain('caption is required');
    expect(server.requests).toHaveLength(0);
  });
});

