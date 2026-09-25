import { request, type Dispatcher } from 'undici';
import { z } from 'zod';
import { classifyError, ExternalApiError, RateLimitError } from '../../errors.js';
import { assertSafeUrl, createSsrfSafeAgent } from '../../security/ssrf.js';
import { defineAction, type IntegrationDriver } from '../integration-driver.js';

/**
 * Generic outbound HTTP action ("http.request"). It demonstrates how new
 * integrations plug into the registry, and it is SSRF-hardened because the
 * destination URL comes from user-authored workflow configuration.
 */

const MAX_RESPONSE_BYTES = 256 * 1024;

export const httpRequestConfigSchema = z.object({
  url: z.string().min(1).max(4_096),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  expectStatus: z.array(z.number().int().min(100).max(599)).optional(),
});

export interface HttpDriverOptions {
  timeoutMs: number;
  keepAliveTimeoutMs: number;
  allowPrivateNetworks: boolean;
  /** Test hook: overrides the SSRF-safe dispatcher. */
  dispatcher?: Dispatcher;
}

async function readBody(body: Dispatcher.ResponseData['body'], contentType: string | undefined): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_RESPONSE_BYTES) {
      body.destroy();
      break;
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (contentType?.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export function createHttpDriver(options: HttpDriverOptions): IntegrationDriver {
  const dispatcher =
    options.dispatcher ??
    createSsrfSafeAgent({
      allowPrivateNetworks: options.allowPrivateNetworks,
      keepAliveTimeoutMs: options.keepAliveTimeoutMs,
      timeoutMs: options.timeoutMs,
    });

  return {
    name: 'http',
    actions: [
      defineAction({
        type: 'http.request',
        configSchema: httpRequestConfigSchema,
        credentialProvider: 'http',
        async execute(config, context) {
          const url = await assertSafeUrl(config.url, { allowPrivateNetworks: options.allowPrivateNetworks });
          const credentialHeaders = (context.credential?.data['headers'] ?? {}) as Record<string, string>;
          const headers: Record<string, string> = { ...config.headers, ...credentialHeaders };
          let payload: string | undefined;
          if (config.body !== undefined && config.method !== 'GET') {
            payload = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);
            if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
          }

          context.markRequestStart();
          let response: Dispatcher.ResponseData;
          try {
            // Redirects are not followed (no redirect interceptor), so a 3xx cannot
            // bounce the request to an internal address.
            response = await request(url, {
              method: config.method,
              headers,
              body: payload ?? null,
              dispatcher,
              signal: context.signal,
            });
          } catch (err) {
            throw classifyError(context.signal.aborted ? (context.signal.reason ?? err) : err);
          }
          context.markResponse();

          const contentType = response.headers['content-type'];
          const body = await readBody(response.body, Array.isArray(contentType) ? contentType[0] : contentType);
          const ok = config.expectStatus ? config.expectStatus.includes(response.statusCode) : response.statusCode < 400;
          if (!ok) {
            if (response.statusCode === 429) {
              const retryAfter = Number(response.headers['retry-after'] ?? 1);
              throw new RateLimitError(`HTTP ${response.statusCode} from ${url.host}`, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
            }
            throw new ExternalApiError(`HTTP ${response.statusCode} from ${url.host}`, response.statusCode, {
              details: { status: response.statusCode, host: url.host },
            });
          }
          return { output: { status: response.statusCode, body } };
        },
      }),
    ],
    async close() {
      if (!options.dispatcher) await dispatcher.close();
    },
  };
}
