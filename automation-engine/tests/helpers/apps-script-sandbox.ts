/**
 * Runs the Google Apps Script files from apps-script/ inside a Node vm context
 * with the Apps Script services they use replaced by in-memory fakes. The feed
 * is served from a Blogger JSON-feed object; webhook calls go to a callback
 * (a recorder in unit tests, or a real HTTP call in end-to-end runs).
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export interface FakeResponse {
  code: number;
  body?: string;
}

export interface FetchOptions {
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  payload?: string;
  muteHttpExceptions?: boolean;
}

export interface FakeTrigger {
  handler: string;
  minutes: number;
  getHandlerFunction(): string;
  getEventType(): string;
}

export interface SandboxOptions {
  files: string[];
  feed: () => { feed: { entry?: unknown[] } };
  webhook: (url: string, options: FetchOptions) => FakeResponse;
  health?: (url: string) => FakeResponse;
  properties?: Record<string, string>;
}

export interface AppsScriptSandbox {
  call<T = unknown>(expression: string): T;
  set(name: string, value: unknown): void;
  logs: string[];
  properties: Map<string, string>;
  triggers: FakeTrigger[];
  webhookCalls: Array<{ url: string; options: FetchOptions; payload: Record<string, unknown> }>;
  sleeps: number[];
}

export function createAppsScriptSandbox(options: SandboxOptions): AppsScriptSandbox {
  const logs: string[] = [];
  const properties = new Map(Object.entries(options.properties ?? {}));
  const triggers: FakeTrigger[] = [];
  const webhookCalls: AppsScriptSandbox['webhookCalls'] = [];
  const sleeps: number[] = [];

  const respond = (r: FakeResponse) => ({ getResponseCode: () => r.code, getContentText: () => r.body ?? '' });
  const makeTrigger = (handler: string, minutes: number): FakeTrigger => ({
    handler,
    minutes,
    getHandlerFunction: () => handler,
    getEventType: () => 'CLOCK',
  });

  const context = vm.createContext({
    Logger: { log: (msg: unknown) => logs.push(String(msg)) },
    Utilities: { sleep: (ms: number) => sleeps.push(ms) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => properties.get(k) ?? null,
        setProperty: (k: string, v: string) => properties.set(k, String(v)),
        getProperties: () => Object.fromEntries(properties),
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: (t: FakeTrigger) => {
        const i = triggers.indexOf(t);
        if (i >= 0) triggers.splice(i, 1);
      },
      newTrigger: (handler: string) => ({
        timeBased: () => ({
          everyMinutes: (minutes: number) => ({
            create: () => {
              const t = makeTrigger(handler, minutes);
              triggers.push(t);
              return t;
            },
          }),
        }),
      }),
    },
    UrlFetchApp: {
      fetch: (url: string, fetchOptions: FetchOptions = {}) => {
        if (url.includes('/feeds/posts/default')) {
          const params = new URL(url).searchParams;
          const start = Number(params.get('start-index') ?? 1);
          const max = Number(params.get('max-results') ?? 25);
          const feed = options.feed();
          const entries = (feed.feed.entry ?? []).slice(start - 1, start - 1 + max);
          return respond({ code: 200, body: JSON.stringify({ ...feed, feed: { ...feed.feed, entry: entries } }) });
        }
        if (url.endsWith('/health')) return respond(options.health ? options.health(url) : { code: 200, body: '{"status":"ok"}' });
        const payload = JSON.parse(fetchOptions.payload ?? '{}') as Record<string, unknown>;
        webhookCalls.push({ url, options: fetchOptions, payload });
        return respond(options.webhook(url, fetchOptions));
      },
    },
  });

  for (const file of options.files) {
    vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  }

  return {
    call: <T>(expression: string) => vm.runInContext(expression, context) as T,
    set: (name, value) => {
      (context as Record<string, unknown>)[name] = value;
    },
    logs,
    properties,
    triggers,
    webhookCalls,
    sleeps,
  };
}
