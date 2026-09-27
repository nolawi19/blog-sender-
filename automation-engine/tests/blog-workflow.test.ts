/**
 * Regression test for the shipped Blogger -> Telegram channel workflow
 * (examples/blog-to-telegram.workflow.json), run through the real workflow
 * engine and Telegram client against a local fake Telegram API.
 *
 * Guards against the production failures:
 *   STEP_CONFIG_INVALID telegram.sendPhoto: "chatId: Invalid input", "photo must not be empty"
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/errors.js';
import { createDefaultRegistry } from '../src/integrations/index.js';
import { DriverRegistry } from '../src/integrations/integration-driver.js';
import { createTelegramDriver, TelegramClient } from '../src/integrations/telegram/telegram-driver.js';
import { compileTemplate, compileValue } from '../src/mapper/template-mapper.js';
import { workflowDefinitionSchema, type RuntimeWorkflow } from '../src/types/workflow.js';
import { StepFailedError, WorkflowEngine } from '../src/workflows/workflow-engine.js';
import { BEARER_TOKEN, BOT_TOKEN, buildTestGateway, makeEvent, silentLogger, testConfig } from './helpers/fixtures.js';
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

/** Returns why Telegram would reject the text, or null. Mirrors the Bot API HTML rules and limits. */
function telegramTextProblem(text: string, html: boolean, limit: number): string | null {
  let visible = text;
  if (html) {
    const allowed = /<\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler)>|<a href="[^"<>]*">|<\/a>/g;
    const withoutTags = text.replace(allowed, '');
    if (/[<>]/.test(withoutTags)) return 'Unsupported start tag or stray "<"';
    if (/&(?!(lt|gt|amp|quot);)/.test(withoutTags)) return 'Character entity expected';
    visible = withoutTags.replace(/&(lt|gt|amp|quot);/g, 'x');
  }
  return visible.length > limit ? 'too_long' : null; // String.length counts UTF-16 code units, like Telegram
}

let telegram: TestServer;
let client: TelegramClient;
let engine: WorkflowEngine;

beforeAll(async () => {
  // Emulates Telegram: photo rules, HTML parse mode rules and length limits (UTF-16 units after entity parsing).
  telegram = await startTestServer((req, res) => {
    const method = req.url.split('/').pop();
    const body = req.json ?? {};
    if (!body['chat_id']) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat_id is empty' });
    if (method === 'sendPhoto') {
      if (!body['photo']) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: there is no photo in the request' });
      let host: string;
      try {
        host = new URL(typeof body['photo'] === 'string' ? body['photo'] : '').hostname;
      } catch {
        return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' });
      }
      if (host.endsWith('.invalid')) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' });
    }
    const rawText = method === 'sendPhoto' ? body['caption'] : body['text'];
    const text = typeof rawText === 'string' ? rawText : '';
    const problem = telegramTextProblem(text, body['parse_mode'] === 'HTML', method === 'sendPhoto' ? 1024 : 4096);
    if (problem) return json(res, 400, { ok: false, error_code: 400, description: problem === 'too_long' ? (method === 'sendPhoto' ? 'Bad Request: message caption is too long' : 'Bad Request: message is too long') : `Bad Request: can't parse entities: ${problem}` });
    if (method === 'sendMessage' && !text.trim()) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty' });
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

async function run(body: Record<string, unknown>, options: { engine?: WorkflowEngine; workflow?: RuntimeWorkflow } = {}) {
  const outcome = await (options.engine ?? engine).execute({
    workflow: options.workflow ?? workflow,
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

  describe('message safety (Amharic, emoji, quotes, HTML, entities, long text)', () => {
    const lastText = (calls: Array<{ method: string | undefined; body: Record<string, unknown> }>) => {
      const last = calls.at(-1)!;
      return String(last.method === 'sendPhoto' ? last.body['caption'] : last.body['text']);
    };
    const URL_ = 'https://yakobsendeku.blogspot.com/2026/09/post.html';

    it('Amharic title and excerpt with emoji, quotes and entities go out as a valid photo caption', async () => {
      const { outcome, calls } = await run(post({
        title: 'ሰላም ዓለም 👋 “ጥቅስ” & it\'s <new>',
        excerpt: '<p>ይህ የሙከራ ጽሑፍ ነው&nbsp;&amp; &#8217;apostrophe&#8217; &hellip; 😀</p><script>alert(1)</script>',
      }));
      expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
      const caption = lastText(calls);
      expect(caption).toContain('<b>ሰላም ዓለም 👋 “ጥቅስ” &amp; it\'s &lt;new&gt;</b>');
      expect(caption).toContain('ይህ የሙከራ ጽሑፍ ነው &amp; ’apostrophe’ … 😀');
      expect(caption).not.toContain('alert');
      expect(caption).not.toContain('&#8217;');
      expect(caption.endsWith(URL_)).toBe(true);
      expect(outcome.steps[0]!.status).toBe('succeeded');
    });

    it('entity-encoded titles are decoded before escaping (no literal &amp; in Telegram)', async () => {
      const { calls } = await run(post({ title: 'Tom &amp; Jerry&#8217;s &quot;day&quot;', image: '' }));
      expect(lastText(calls)).toContain('<b>Tom &amp; Jerry’s &quot;day&quot;</b>');
      expect(lastText(calls)).not.toContain('&amp;amp;');
    });

    it('very long Amharic title and excerpt are truncated to fit the 1024 caption limit, keeping the URL', async () => {
      const { calls } = await run(post({ title: 'ረጅም ርዕስ '.repeat(60), excerpt: 'የኢትዮጵያ ታሪክ ረጅም ነው። '.repeat(300) }));
      expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
      const caption = lastText(calls);
      expect(caption.endsWith(URL_)).toBe(true);
      expect(caption).toContain('…');
      expect(telegramTextProblem(caption, true, 1024)).toBeNull();
    });

    it('emoji-heavy excerpts that exceed the caption limit are still delivered (as text) with the URL', async () => {
      const { outcome, calls } = await run(post({ excerpt: '😀'.repeat(900) }));
      expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
      expect(lastText(calls).endsWith(URL_)).toBe(true);
      expect(outcome.steps[0]).toMatchObject({ status: 'succeeded', output: { fallback: 'sendMessage' } });
    });

    it('text messages stay under 4096 even for a huge emoji-only excerpt, keeping the URL', async () => {
      const { outcome, calls } = await run(post({ image: '', title: '🔥'.repeat(300), excerpt: '😀'.repeat(5000) }));
      expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
      const text = lastText(calls);
      expect(telegramTextProblem(text, true, 4096)).toBeNull();
      expect(text.endsWith(URL_)).toBe(true);
      expect(outcome.steps.at(-1)!.status).toBe('succeeded');
    });

    it('markup-looking text in titles and Blogger HTML never produces invalid Telegram HTML', async () => {
      for (const title of ['a < b && c > d', '<b>bold?</b>', '&amp;&lt;script&gt;', 'Tom & "Jerry"', '5 > 3 & 2 < 4']) {
        const { outcome, calls } = await run(post({ title, excerpt: '<div><b>unclosed <i>tags & stray < signs</div>', image: '' }));
        expect(outcome.steps.at(-1)!.status).toBe('succeeded');
        expect(telegramTextProblem(lastText(calls), true, 4096)).toBeNull();
        telegram.requests.length = 0;
      }
    });
  });
});


describe('Telegram destination comes from TELEGRAM_CHANNEL_ID (never from the Blogger payload)', () => {
  const ENV_CHANNEL = '-1009876543210';
  const engineFor = (env: NodeJS.ProcessEnv) => {
    // The same wiring as the worker: .env -> loadConfig -> createDefaultRegistry -> TelegramDriver.
    const config = testConfig({
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_API_BASE_URL: telegram.url,
      TELEGRAM_WARMUP_CONNECTIONS: '0',
      TELEGRAM_KEEP_WARM_INTERVAL_MS: '0',
      TELEGRAM_INLINE_RETRIES: '0',
      ...env,
    });
    const registry = createDefaultRegistry(config, silentLogger());
    return { registry, engine: new WorkflowEngine({ registry, logger: silentLogger(), defaultStepTimeoutMs: 2_000 }) };
  };

  it('sendPhoto (post with image) and sendMessage (post without image) both use TELEGRAM_CHANNEL_ID from the environment', async () => {
    const { registry, engine: envEngine } = engineFor({ TELEGRAM_CHANNEL_ID: ENV_CHANNEL });
    try {
      const withImage = await run(post({ id: 'env-1' }), { engine: envEngine });
      expect(withImage.calls.map((c) => [c.method, c.body['chat_id']])).toEqual([['sendPhoto', ENV_CHANNEL]]);
      telegram.requests.length = 0;
      const withoutImage = await run(post({ id: 'env-2', image: '' }), { engine: envEngine });
      expect(withoutImage.calls.map((c) => [c.method, c.body['chat_id']])).toEqual([['sendMessage', ENV_CHANNEL]]);
    } finally {
      await registry.closeAll();
    }
  });

  it('does not need telegram_chat_id: a legacy chatId template that renders empty falls back to TELEGRAM_CHANNEL_ID', async () => {
    // The old workflow used "chatId": "{{trigger.body.telegram_chat_id}}", which Blogger never sends.
    const legacy: RuntimeWorkflow = {
      ...workflow,
      steps: workflow.steps.map((step, i) => ({
        ...step,
        config: compileValue({ ...(definition.steps[i]!.config), chatId: '{{trigger.body.telegram_chat_id}}' }),
      })),
    };
    for (const payload of [post({}), post({ image: '' }), post({ telegram_chat_id: '' }), post({ telegram_chat_id: null, image: '' })]) {
      const { outcome, calls } = await run(payload, { workflow: legacy });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body['chat_id']).toBe(CHANNEL);
      expect(outcome.steps.every((s) => s.status !== 'failed')).toBe(true);
      telegram.requests.length = 0;
    }
  });

  it.each([
    ['unset', {}],
    ['empty', { TELEGRAM_CHANNEL_ID: '' }],
  ])('TELEGRAM_CHANNEL_ID %s -> clear, non-retryable configuration error and no Telegram call', async (_label, env) => {
    const { registry, engine: noChannelEngine } = engineFor(env);
    try {
      for (const payload of [post({}), post({ image: '' })]) {
        const err = await run(payload, { engine: noChannelEngine }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StepFailedError);
        const cause = (err as StepFailedError).error;
        expect(cause).toBeInstanceOf(ConfigurationError);
        expect(cause).toMatchObject({ code: 'TELEGRAM_CHAT_MISSING', retryable: false });
        expect(cause.message).toMatch(/^TELEGRAM_CHANNEL_ID is required/);
        expect(telegram.requests).toHaveLength(0);
      }
    } finally {
      await registry.closeAll();
    }
  });
});

describe('duplicate Blogger events (/webhooks/blog, Bearer auth, idempotencyField "id")', () => {
  it('the same post sent again (5-minute polling, sendExistingPosts, retries) is accepted once and enqueued once', async () => {
    const gw = await buildTestGateway({ endpoint: { idempotencyPath: [file.endpoint.idempotencyField] } });
    try {
      const headers = { authorization: `Bearer ${BEARER_TOKEN}`, 'content-type': 'application/json' };
      const blogPost = post({ id: 'tag:blogger.com,1999:blog-1.post-42' });
      const first = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers, payload: blogPost });
      const again = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers, payload: blogPost });
      const edited = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers, payload: { ...blogPost, title: 'Edited title' } });
      const other = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers, payload: post({ id: 'tag:blogger.com,1999:blog-1.post-43' }) });
      expect([first.statusCode, again.statusCode, edited.statusCode, other.statusCode]).toEqual([202, 200, 200, 202]);
      expect(again.json()).toMatchObject({ duplicate: true, eventId: first.json().eventId });
      expect(gw.publisher.jobs).toHaveLength(2);
      expect(gw.publisher.jobs.map((j) => j.idempotencyKey)).toEqual([
        'f:tag:blogger.com,1999:blog-1.post-42',
        'f:tag:blogger.com,1999:blog-1.post-43',
      ]);
      const unauthorized = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { 'content-type': 'application/json' }, payload: blogPost });
      expect(unauthorized.statusCode).toBe(401);
    } finally {
      await gw.app.close();
    }
  });
});

describe('every shipped example workflow (examples/*.workflow.json)', () => {
  const dir = new URL('../examples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.workflow.json'));
  let knownTypes: string[] = [];
  beforeAll(async () => {
    const registry = createDefaultRegistry(testConfig({ TELEGRAM_WARMUP_CONNECTIONS: '0' }), silentLogger());
    knownTypes = registry.listActionTypes();
    await registry.closeAll();
  });

  it.each(files)('%s parses, compiles, uses known actions and sends to TELEGRAM_CHANNEL_ID', (name) => {
    const parsed = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as { workflows: unknown[] };
    for (const raw of parsed.workflows) {
      const wf = workflowDefinitionSchema.parse(raw);
      for (const step of wf.steps) {
        expect(knownTypes).toContain(step.type);
        compileValue(step.config);
        if (step.runIf) compileTemplate(step.runIf);
        expect(step.config).not.toHaveProperty('chatId');
        if (step.type === 'telegram.sendPhoto') expect(String(step.config['photo'])).toContain('| http_url');
      }
    }
  });
});
