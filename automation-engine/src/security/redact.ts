/**
 * Secret scrubbing for anything that may end up in logs, error messages, execution
 * rows or dead-letter payloads. Telegram bot tokens live in the URL path
 * (/bot<token>/method), so they are matched by shape, not only by field name.
 */

const TELEGRAM_TOKEN = /(?<![0-9])\d{5,16}:[A-Za-z0-9_-]{30,64}(?![A-Za-z0-9_-])/g;
const BOT_PATH = /\/bot[^/\s]+\//g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const SIGNATURE = /\b(sha256=)[0-9a-f]{16,}/gi;

export const REDACTED = '[REDACTED]';

export function redactSecrets(input: string): string {
  if (input.length === 0) return input;
  return input
    .replace(BOT_PATH, `/bot${REDACTED}/`)
    .replace(TELEGRAM_TOKEN, REDACTED)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(SIGNATURE, `$1${REDACTED}`);
}

/** Header names whose values are never forwarded to workflows unless explicitly enabled. */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-webhook-token',
  'x-webhook-signature',
  'x-api-key',
]);

/** Pino redact paths: structured fields that must never be written in clear text. */
export const LOG_REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-webhook-token"]',
  'req.headers["x-webhook-signature"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-webhook-token"]',
  'headers["x-webhook-signature"]',
  '*.botToken',
  '*.token',
  '*.secret',
  '*.password',
  '*.apiKey',
  '*.encryptionKey',
  'botToken',
  'token',
  'secret',
  'password',
  'credential',
  '*.credential',
];
