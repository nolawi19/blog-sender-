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
      let host = '';
      try {
        host = new URL(String(body['photo'])).hostname;
      } catch {
        return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' });
      }
      if (host.endsWith('.invalid')) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' });
    }
    const text = String((method === 'sendPhoto' ? body['caption'] : body['text']) ?? '');
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

