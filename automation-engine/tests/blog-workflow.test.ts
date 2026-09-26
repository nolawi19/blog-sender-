/**
 * Regression test for the shipped Blogger -> Telegram channel workflow
 * (examples/blog-to-telegram.workflow.json), run through the real workflow
 * engine and Telegram client against a local fake Telegram API.
 *
 * Guards against the production failures:
 *   STEP_CONFIG_INVALID telegram.sendPhoto: "chatId: Invalid input", "photo must not be empty"
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DriverRegistry } from '../src/integrations/integration-driver.js';
import { createTelegramDriver, TelegramClient } from '../src/integrations/telegram/telegram-driver.js';
import { compileTemplate, compileValue } from '../src/mapper/template-mapper.js';
import { workflowDefinitionSchema, type RuntimeWorkflow } from '../src/types/workflow.js';
import { WorkflowEngine } from '../src/workflows/workflow-engine.js';
import { BOT_TOKEN, makeEvent, silentLogger } from './helpers/fixtures.js';
import { json, startTestServer, telegramOk, type TestServer } from './helpers/http-server.js';

const CHANNEL = '@automation_test_channel';

const file = JSON.parse(readFileSync(new URL('../examples/blog-to-telegram.workflow.json', import.meta.url), 'utf8')) as {
  endpoint: { slug: string; defaultEventType: string; idempotencyField: string };
  workflows: unknown[];
};
const definition = workflowDefinitionSchema.parse(file.workflows[0]);

const workflow: RuntimeWorkflow = {
  id: 'wf-blog',
  name: definition.name,
  userId: 'u',
  endpointId: 'ep',
  triggerEvent: definition.trigger.event,
  version: 2,
  steps: definition.steps.map((step, i) => ({
    id: `st-${i}`,
    key: step.key ?? `step_${i + 1}`,
    position: i,
    type: step.type,
    config: compileValue(step.config),
    runIf: step.runIf ? compileTemplate(step.runIf) : null,
    credential: null, // the bot token comes from TELEGRAM_BOT_TOKEN in these tests
    timeoutMs: step.timeoutMs ?? null,
  })),
};

let telegram: TestServer;
let client: TelegramClient;
let engine: WorkflowEngine;

beforeAll(async () => {
  // Emulates Telegram's photo rules: non-URL -> "wrong file identifier", unreachable host -> "failed to get HTTP URL content".
  telegram = await startTestServer((req, res) => {
    const method = req.url.split('/').pop();
    const body = req.json ?? {};
    if (!body['chat_id']) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat_id is empty' });
    if (method === 'sendPhoto') {
      if (!body['photo']) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: there is no photo in the request' });
      let host = '';
      try {
        host = new URL(String(body['photo'])).hostname;
      } catch {
        return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' });
      }
      if (host.endsWith('.invalid')) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' });
    }
    if (method === 'sendMessage' && !body['text']) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty' });
    telegramOk(res, -1001234567890);
  });
  client = new TelegramClient({
    baseUrl: telegram.url,
    timeoutMs: 2_000,
    connections: 2,
    keepAliveTimeoutMs: 10_000,
    inlineRetries: 0,
    rateLimit: { globalPerSec: 1_000, perChatPerSec: 1_000, perChatBurst: 1_000, maxWaitMs: 50 },
    warmupConnections: 0,
    keepWarmIntervalMs: 0,
    logger: silentLogger(),
  });
  const registry = new DriverRegistry().register(createTelegramDriver(client, { defaultBotToken: BOT_TOKEN, defaultChatId: CHANNEL }));
  engine = new WorkflowEngine({ registry, logger: silentLogger(), defaultStepTimeoutMs: 2_000 });
});

afterAll(async () => {
  await client.close();
  await telegram.close();
});

beforeEach(() => {
  telegram.requests.length = 0;
});

const post = (overrides: Record<string, unknown>) => ({
  id: 'post-1',
  type: 'post.published',
  title: 'Post title',
  excerpt: '<p>Post <b>description</b> &amp; more</p>',
  url: 'https://yakobsendeku.blogspot.com/2026/09/post.html',
  image: 'https://blogger.googleusercontent.com/img/b/cover.jpg',
  author: { name: 'Nolawi' },
  ...overrides,
});

async function run(body: Record<string, unknown>) {
  const outcome = await engine.execute({
    workflow,
    event: makeEvent(body),
    executionId: 'exec-1',
    attempt: 1,
    receivedAt: Date.now(),
    signal: AbortSignal.timeout(5_000),
  });
  const calls = telegram.requests.map((r) => ({ method: r.url.split('/').pop(), body: r.json ?? {} }));
  return { outcome, calls };
}

describe('Blogger -> Telegram channel workflow (examples/blog-to-telegram.workflow.json)', () => {
  it('keeps the endpoint, event type and idempotency configuration', () => {
    expect(file.endpoint).toMatchObject({ slug: 'blog', defaultEventType: 'post.published', idempotencyField: 'id' });
    expect(definition.trigger.event).toBe('post.published');
    for (const step of definition.steps) expect(step.config).not.toHaveProperty('chatId');
  });

  it('post WITH image -> one sendPhoto to the channel with title, excerpt and URL', async () => {
    const { outcome, calls } = await run(post({}));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendPhoto');
    expect(calls[0]!.body).toMatchObject({ chat_id: CHANNEL, photo: 'https://blogger.googleusercontent.com/img/b/cover.jpg', parse_mode: 'HTML' });
    const caption = String(calls[0]!.body['caption']);
    expect(caption).toContain('<b>Post title</b>');
    expect(caption).toContain('Post description &amp; more');
    expect(caption).toContain('https://yakobsendeku.blogspot.com/2026/09/post.html');
    expect(outcome.steps.map((s) => [s.stepKey, s.status])).toEqual([
      ['announce', 'succeeded'],
      ['announce_text', 'skipped'],
    ]);
  });

  it.each([
    ['empty string', { image: '' }],
    ['whitespace', { image: '   ' }],
    ['null', { image: null }],
    ['missing field', { image: undefined }],
    ['not a URL', { image: 'not-a-valid-image-url' }],
    ['non-http scheme', { image: 'data:image/png;base64,AAAA' }],
  ])('post with %s image -> sendMessage only, never sendPhoto', async (_label, overrides) => {
    const { outcome, calls } = await run(post(overrides));
    expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(calls[0]!.body).toMatchObject({ chat_id: CHANNEL, parse_mode: 'HTML' });
    const text = String(calls[0]!.body['text']);
    expect(text).toContain('<b>Post title</b>');
    expect(text).toContain('Post description &amp; more');
    expect(text).toContain('https://yakobsendeku.blogspot.com/2026/09/post.html');
    expect(outcome.steps.map((s) => [s.stepKey, s.status])).toEqual([
      ['announce', 'skipped'],
      ['announce_text', 'succeeded'],
    ]);
  });

  it('image URL Telegram cannot fetch -> falls back to sendMessage and still succeeds', async () => {
    const { outcome, calls } = await run(post({ image: 'https://images.invalid/cover.jpg' }));
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(calls[1]!.body['chat_id']).toBe(CHANNEL);
    expect(String(calls[1]!.body['text'])).toContain('https://yakobsendeku.blogspot.com/2026/09/post.html');
    expect(outcome.steps[0]).toMatchObject({ stepKey: 'announce', status: 'succeeded', output: { fallback: 'sendMessage' } });
    expect(outcome.steps[1]!.status).toBe('skipped');
  });

  it('upgrades protocol-relative Blogger image URLs to https', async () => {
    const { calls } = await run(post({ image: '//blogger.googleusercontent.com/img/b/cover.jpg' }));
    expect(calls[0]).toMatchObject({ method: 'sendPhoto', body: { photo: 'https://blogger.googleusercontent.com/img/b/cover.jpg' } });
  });

  it('handles a minimal payload (only id and type) without failing', async () => {
    const { outcome, calls } = await run({ id: 'p', type: 'post.published' });
    expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(String(calls[0]!.body['text'])).toContain('<b>New post</b>');
    expect(outcome.steps.at(-1)!.status).toBe('succeeded');
  });

  it('escapes HTML in titles so Telegram never rejects the message', async () => {
    const { calls } = await run(post({ title: 'Tips & <tricks>', image: '' }));
    expect(String(calls[0]!.body['text'])).toContain('<b>Tips &amp; &lt;tricks&gt;</b>');
  });
});
