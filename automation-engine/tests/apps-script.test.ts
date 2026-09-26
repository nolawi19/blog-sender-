/**
 * Tests for apps-script/AutomationEngineTools.gs and apps-script/BloggerToTelegram.gs,
 * executed as real JavaScript in a sandbox with Apps Script services faked and
 * a Blogger JSON-feed fixture (tests/fixtures/blogger-feed.json).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAppsScriptSandbox, type AppsScriptSandbox, type FakeResponse } from './helpers/apps-script-sandbox.js';

const TOOLS = 'apps-script/AutomationEngineTools.gs';
const MAIN = 'apps-script/BloggerToTelegram.gs';
const FIXTURE = JSON.parse(readFileSync('tests/fixtures/blogger-feed.json', 'utf8')) as { feed: { entry: Array<Record<string, unknown>> } };
const SECRET_TOKEN = 'secret-webhook-token-value-123';
const WEBHOOK_URL = 'https://example-tunnel.trycloudflare.com/webhooks/blog';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('aeExtractImage (first usable image)', () => {
  const box = createAppsScriptSandbox({ files: [TOOLS], feed: () => FIXTURE, webhook: () => ({ code: 202 }) });
  const extract = (entryIndex: number) => {
    box.set('__entry', FIXTURE.feed.entry[entryIndex]);
    return box.call<string>('aeExtractImage(__entry)');
  };

  it('takes the first <img> in the post and upgrades Blogger sizes to s1600', () => {
    expect(extract(0)).toBe('https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEiTESTIMAGE/s1600/cover.jpg');
  });
  it('returns "" for posts without images', () => {
    expect(extract(1)).toBe('');
  });
  it('skips data: URIs, 1x1 tracking pixels and malformed src values', () => {
    expect(extract(2)).toBe('');
  });
  it('falls back to the feed thumbnail (summary feeds) and upscales it', () => {
    expect(extract(3)).toBe('https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEiTHUMB/s1600/thumb.png');
  });
  it('turns protocol-relative blogspot images into https', () => {
    expect(extract(5)).toBe('https://1.bp.blogspot.com/-abc/XYZ/AAAA/s1600/photo.jpg');
  });
  it('accepts raw HTML strings and Blogger API v3 posts', () => {
    expect(box.call("aeExtractImage('<p>x</p><img src=\"https://a.example.com/b.jpg\">')")).toBe('https://a.example.com/b.jpg');
    expect(box.call("aeExtractImage({ content: '<p>no image</p>', images: [{ url: 'https://c.example.com/d.png' }] })")).toBe('https://c.example.com/d.png');
    expect(box.call('aeExtractImage(null)')).toBe('');
    expect(box.call("aeExtractImage('<img src=\"https://x.example.com/a.jpg?x=1&amp;y=2\">')")).toBe('https://x.example.com/a.jpg?x=1&y=2');
  });
});

describe('aeEnsureTrigger (no duplicate triggers)', () => {
  it('creates one 5-minute trigger, then leaves it alone', () => {
    const box = createAppsScriptSandbox({ files: [TOOLS], feed: () => FIXTURE, webhook: () => ({ code: 202 }) });
    expect(box.call('aeEnsureTrigger()')).toBe('created');
    expect(box.call('aeEnsureTrigger()')).toBe('kept');
    expect(box.call('aeEnsureTrigger()')).toBe('kept');
    expect(box.triggers.map((t) => [t.handler, t.minutes])).toEqual([['checkNewPosts', 5]]);
  });

  it('removes duplicates down to exactly one', () => {
    const box = createAppsScriptSandbox({ files: [TOOLS], feed: () => FIXTURE, webhook: () => ({ code: 202 }) });
    box.call('aeEnsureTrigger()');
    box.call("ScriptApp.newTrigger('checkNewPosts').timeBased().everyMinutes(5).create()");
    box.call("ScriptApp.newTrigger('checkNewPosts').timeBased().everyMinutes(1).create()");
    expect(box.call('aeEnsureTrigger()')).toBe('deduplicated');
    expect(box.triggers).toHaveLength(1);
  });

  it('respects a custom polling function name', () => {
    const box = createAppsScriptSandbox({ files: [TOOLS], feed: () => FIXTURE, webhook: () => ({ code: 202 }) });
    box.call("AE_POLL_HANDLER = 'checkForNewBlogPosts'");
    box.call('aeEnsureTrigger()');
    expect(box.triggers[0]!.handler).toBe('checkForNewBlogPosts');
  });
});

describe('aeDiagnose (read-only report)', () => {
  it('reports triggers, property NAMES only, tunnel health and photo/text per post', () => {
    const box = createAppsScriptSandbox({
      files: [TOOLS, MAIN],
      feed: () => FIXTURE,
      webhook: () => ({ code: 202 }),
      properties: { WEBHOOK_URL, WEBHOOK_TOKEN: SECRET_TOKEN },
    });
    box.call('setupTrigger()');
    const problems = box.call<number>('aeDiagnose()');
    const log = box.logs.join('\n');
    expect(problems).toBe(0);
    expect(log).toContain('Trigger checkNewPosts (CLOCK) x1');
    expect(log).toContain('sendExistingPosts() exists');
    expect(log).toContain('Script Property names: WEBHOOK_URL, WEBHOOK_TOKEN');
    expect(log).toContain('Engine /health through the tunnel: HTTP 200');
    expect(log).toMatch(/photo {2}ሰላም ዓለም/);
    expect(log).toMatch(/text {3}Tips & "tricks"/);
    expect(log).not.toContain(SECRET_TOKEN);
    expect(log).not.toContain('example-tunnel');
    expect(box.webhookCalls).toHaveLength(0); // diagnose never posts
  });

  it('flags a dead tunnel and missing triggers', () => {
    const box = createAppsScriptSandbox({
      files: [TOOLS],
      feed: () => FIXTURE,
      webhook: () => ({ code: 202 }),
      health: () => ({ code: 530 }),
      properties: { WEBHOOK_URL, WEBHOOK_TOKEN: SECRET_TOKEN },
    });
    expect(box.call<number>('aeDiagnose()')).toBe(2);
    expect(box.logs.join('\n')).toContain('HTTP 530');
    expect(box.logs.join('\n')).toContain('No triggers');
  });
});

describe('BloggerToTelegram.gs reference script', () => {
  let feed: typeof FIXTURE;
  let responses: FakeResponse[];
  let box: AppsScriptSandbox;

  beforeEach(() => {
    feed = clone(FIXTURE);
    responses = [];
    box = createAppsScriptSandbox({
      files: [TOOLS, MAIN],
      feed: () => feed,
      webhook: () => responses.shift() ?? { code: 202, body: '{"accepted":true}' },
      properties: { WEBHOOK_URL, WEBHOOK_TOKEN: SECRET_TOKEN },
    });
  });

  it('sendExistingPosts sends every post once, oldest first, in the engine payload format', () => {
    const result = box.call<Record<string, number>>('sendExistingPosts()');
    expect(result).toEqual({ sent: 6, duplicate: 0, failed: 0 });
    const payloads = box.webhookCalls.map((c) => c.payload);
    expect(payloads.map((p) => p['id'])).toEqual(['7000000000000000001', '7000000000000000002', '7000000000000000003', '7000000000000000004', '7000000000000000005', '7000000000000000006']);
    const first = box.webhookCalls[0]!;
    expect(first.url).toBe(WEBHOOK_URL);
    expect(first.options.headers).toEqual({ Authorization: `Bearer ${SECRET_TOKEN}` });
    const newest = payloads[5]!;
    expect(newest).toMatchObject({
      type: 'post.published',
      title: 'ሰላም ዓለም 👋 — አዲስ ጽሑፍ',
      url: 'https://yakobsendeku.blogspot.com/2026/09/post-0006.html',
      image: 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEiTESTIMAGE/s1600/cover.jpg',
      author: { name: 'Nolawi' },
    });
    expect(String(newest['excerpt'])).toContain('ይህ የሙከራ ጽሑፍ ነው');
    expect(payloads[4]!['image']).toBe('');
    expect(String(payloads[4]!['excerpt'])).not.toContain('alert');
    expect(box.sleeps.length).toBe(5);

    // Running it again sends nothing.
    box.webhookCalls.length = 0;
    expect(box.call('sendExistingPosts()')).toEqual({ sent: 0, duplicate: 0, failed: 0 });
    expect(box.webhookCalls).toHaveLength(0);
  });

  it('checkNewPosts: first run only records a baseline, later runs send only new posts, once', () => {
    expect(box.call('checkNewPosts()')).toMatchObject({ sent: 0, baseline: 6 });
    expect(box.webhookCalls).toHaveLength(0);

    const newPost = clone(feed.feed.entry[1]!);
    (newPost['id'] as { $t: string }).$t = 'tag:blogger.com,1999:blog-4242424242424242424.post-7000000000000000007';
    feed.feed.entry.unshift(newPost);
    expect(box.call('checkNewPosts()')).toEqual({ sent: 1, duplicate: 0, failed: 0 });
    expect(box.webhookCalls.map((c) => c.payload['id'])).toEqual(['7000000000000000007']);

    // The next 5-minute runs find nothing new.
    expect(box.call('checkNewPosts()')).toEqual({ sent: 0, duplicate: 0, failed: 0 });
    expect(box.call('checkNewPosts()')).toEqual({ sent: 0, duplicate: 0, failed: 0 });
    expect(box.webhookCalls).toHaveLength(1);
  });

  it('treats the engine "duplicate" answer (HTTP 200) as done and retries failures on the next run', () => {
    box.call('checkNewPosts()');
    const a = clone(feed.feed.entry[0]!);
    (a['id'] as { $t: string }).$t = 'tag:blogger.com,1999:blog-1.post-8000000000000000001';
    feed.feed.entry.unshift(a);
    responses.push({ code: 502, body: 'Bad gateway' });
    expect(box.call('checkNewPosts()')).toEqual({ sent: 0, duplicate: 0, failed: 1 });
    responses.push({ code: 200, body: '{"duplicate":true}' });
    expect(box.call('checkNewPosts()')).toEqual({ sent: 0, duplicate: 1, failed: 0 });
    expect(box.call('checkNewPosts()')).toEqual({ sent: 0, duplicate: 0, failed: 0 });
  });

  it('stops on HTTP 401 and never logs the token', () => {
    responses.push({ code: 401, body: '{"error":{"code":"UNAUTHORIZED"}}' });
    expect(box.call('sendExistingPosts()')).toEqual({ sent: 0, duplicate: 0, failed: 1 });
    const log = box.logs.join('\n');
    expect(log).toContain('HTTP 401');
    expect(log).not.toContain(SECRET_TOKEN);
  });

  it('setupTrigger creates exactly one checkNewPosts trigger', () => {
    box.call('setupTrigger()');
    box.call('setupTrigger()');
    expect(box.triggers.map((t) => t.handler)).toEqual(['checkNewPosts']);
  });
});
