/**
 * Channel setup verification (src/scripts/check-telegram.ts) and the
 * actionable hints attached to Telegram errors.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramClient, toTelegramError } from '../src/integrations/telegram/telegram-driver.js';
import { runTelegramChecks } from '../src/scripts/check-telegram.js';
import { BOT_TOKEN, silentLogger } from './helpers/fixtures.js';
import { json, startTestServer, telegramOk, type TestServer } from './helpers/http-server.js';

type Member = { status: string; can_post_messages?: boolean };
let server: TestServer;
let client: TelegramClient;
let chatType = 'channel';
let member: Member = { status: 'administrator', can_post_messages: true };
let sendError: string | null = null;

beforeEach(async () => {
  chatType = 'channel';
  member = { status: 'administrator', can_post_messages: true };
  sendError = null;
  server = await startTestServer((req, res) => {
    const method = req.url.split('/').pop();
    if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 42, is_bot: true, username: 'blog_bot' } });
    if (method === 'getChat') {
      if (req.json?.['chat_id'] === '@missing_channel') return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
      return json(res, 200, { ok: true, result: { id: -1001234567890, type: chatType, title: 'Yakob Sendeku', username: 'test_channel' } });
    }
    if (method === 'getChatMember') return json(res, 200, { ok: true, result: { ...member, user: { id: 42 } } });
    if (method === 'sendMessage') {
      if (sendError) return json(res, 403, { ok: false, error_code: 403, description: sendError });
      return telegramOk(res, -1001234567890, 77);
    }
    return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
  });
  client = new TelegramClient({
    baseUrl: server.url,
    timeoutMs: 2_000,
    connections: 1,
    keepAliveTimeoutMs: 5_000,
    inlineRetries: 0,
    rateLimit: { globalPerSec: 100, perChatPerSec: 100, perChatBurst: 100, maxWaitMs: 100 },
    warmupConnections: 0,
    keepWarmIntervalMs: 0,
    logger: silentLogger(),
  });
});

afterEach(async () => {
  await client.close();
  await server.close();
});

async function check(overrides: { token?: string | undefined; channel?: string | undefined; sendTest?: boolean } = {}) {
  const lines: string[] = [];
  const ok = await runTelegramChecks({
    token: 'token' in overrides ? overrides.token : BOT_TOKEN,
    channel: 'channel' in overrides ? overrides.channel : '@test_channel',
    client,
    sendTest: overrides.sendTest ?? false,
    write: (l) => lines.push(l),
  });
  return { ok, output: lines.join('\n') };
}

describe('check-telegram', () => {
  it('passes when the bot is a channel administrator that can post, and never prints the token', async () => {
    const { ok, output } = await check();
    expect(ok).toBe(true);
    expect(output).toContain('PASS  TELEGRAM_BOT_TOKEN     SET');
    expect(output).toContain('PASS  bot token valid        bot @blog_bot');
    expect(output).toContain('PASS  destination is channel "Yakob Sendeku" (@test_channel)');
    expect(output).toContain('PASS  bot can post           bot is administrator with "Post messages"');
    expect(output).not.toContain(BOT_TOKEN);
    expect(server.requests.some((r) => r.url.endsWith('/sendMessage'))).toBe(false); // read-only by default
  });

  it('--send-test sends one real message to the channel', async () => {
    const { ok, output } = await check({ sendTest: true });
    expect(ok).toBe(true);
    expect(output).toContain('PASS  test message sent      message_id 77');
    expect(server.requests.filter((r) => r.url.endsWith('/sendMessage'))).toHaveLength(1);
  });

  it('fails with the exact fix when the bot is not an administrator', async () => {
    member = { status: 'left' };
    const { ok, output } = await check();
    expect(ok).toBe(false);
    expect(output).toContain('FAIL  bot can post           bot status is "left": add the bot as a channel administrator with "Post messages"');
  });

  it('fails when the bot is an administrator without "Post messages"', async () => {
    member = { status: 'administrator', can_post_messages: false };
    const { ok, output } = await check();
    expect(ok).toBe(false);
    expect(output).toContain('WITHOUT "Post messages"');
  });

  it('rejects a personal chat as destination', async () => {
    chatType = 'private';
    const { ok, output } = await check();
    expect(ok).toBe(false);
    expect(output).toContain('is a PERSONAL chat, not a channel');
  });

  it('explains "chat not found"', async () => {
    const { ok, output } = await check({ channel: '@missing_channel' });
    expect(ok).toBe(false);
    expect(output).toContain('chat not found');
    expect(output).toContain('TELEGRAM_CHANNEL_ID does not match a channel the bot can see');
  });

  it('reports missing variables by NAME only', async () => {
    const { ok, output } = await check({ token: undefined, channel: undefined });
    expect(ok).toBe(false);
    expect(output).toContain('FAIL  TELEGRAM_BOT_TOKEN     MISSING');
    expect(output).toContain('FAIL  TELEGRAM_CHANNEL_ID    MISSING');
  });

  it('shows the permission hint when a real send is forbidden', async () => {
    sendError = 'Forbidden: bot is not a member of the channel chat';
    const { ok, output } = await check({ sendTest: true });
    expect(ok).toBe(false);
    expect(output).toContain('Add the bot to the channel as an administrator with the "Post messages" permission.');
  });
});

describe('Telegram error hints', () => {
  it.each([
    ['Forbidden: bot is not a member of the channel chat', 403, 'administrator'],
    ['Bad Request: need administrator rights in the channel chat', 400, 'administrator'],
    ['Bad Request: chat not found', 400, 'TELEGRAM_CHANNEL_ID'],
    ['Forbidden: bot was blocked by the user', 403, 'personal chat'],
    ["Bad Request: can't parse entities: Unsupported start tag", 400, 'escape_html'],
    ['Unauthorized', 401, 'TELEGRAM_BOT_TOKEN'],
  ])('"%s" carries an actionable hint', (description, status, expected) => {
    const err = toTelegramError('sendMessage', status, { ok: false, error_code: status, description });
    expect(String(err.details?.['hint'])).toContain(expected);
  });

  it('keeps the existing error codes and retry decisions', () => {
    expect(toTelegramError('sendMessage', 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })).toMatchObject({ code: 'TELEGRAM_BAD_REQUEST', retryable: false });
    expect(toTelegramError('sendMessage', 403, { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the channel chat' })).toMatchObject({ code: 'TELEGRAM_FORBIDDEN', retryable: false });
    expect(toTelegramError('sendMessage', 502, { ok: false, error_code: 502, description: 'Bad Gateway' })).toMatchObject({ retryable: true });
  });
});
