import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-webhook-signature';
export const TIMESTAMP_HEADER = 'x-webhook-timestamp';
const SIGNATURE_PREFIX = 'sha256=';

/**
 * Signature scheme (documented in the README):
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: sha256=<hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))>
 * Binding the timestamp into the MAC and enforcing a tolerance window prevents
 * replaying a captured request later.
 */
export function signPayload(secret: string, timestampSec: number | string, rawBody: Buffer | string): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestampSec}.`);
  mac.update(rawBody);
  return `${SIGNATURE_PREFIX}${mac.digest('hex')}`;
}

export type SignatureFailure =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'malformed_signature'
  | 'signature_mismatch';

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

export interface VerifySignatureInput {
  secret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  toleranceSec: number;
  nowSec?: number;
}

export function verifySignature(input: VerifySignatureInput): SignatureCheck {
  const { signatureHeader, timestampHeader } = input;
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!timestampHeader) return { ok: false, reason: 'missing_timestamp' };
  if (!/^\d{1,12}$/.test(timestampHeader)) return { ok: false, reason: 'invalid_timestamp' };

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestampHeader)) > input.toleranceSec) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  // Several signatures may be sent comma-separated during secret rotation.
  const candidates = signatureHeader.split(',').map((s) => s.trim());
  const expected = Buffer.from(signPayload(input.secret, timestampHeader, input.rawBody).slice(SIGNATURE_PREFIX.length), 'hex');
  let wellFormed = false;
  for (const candidate of candidates) {
    if (!candidate.startsWith(SIGNATURE_PREFIX)) continue;
    const hex = candidate.slice(SIGNATURE_PREFIX.length);
    if (!/^[0-9a-f]{64}$/i.test(hex)) continue;
    wellFormed = true;
    if (timingSafeEqual(Buffer.from(hex, 'hex'), expected)) return { ok: true };
  }
  return { ok: false, reason: wellFormed ? 'signature_mismatch' : 'malformed_signature' };
}

/** SHA-256 hex digest; bearer tokens are stored only in this form. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented token against a stored SHA-256 hash. */
export function verifyToken(presented: string | undefined, expectedHashHex: string | null | undefined): boolean {
  if (!presented || !expectedHashHex || !/^[0-9a-f]{64}$/i.test(expectedHashHex)) return false;
  const actual = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(actual, Buffer.from(expectedHashHex, 'hex'));
}

/** Extracts a bearer token from `Authorization: Bearer <t>` or `X-Webhook-Token: <t>`. */
export function extractBearerToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const alt = headers['x-webhook-token'];
  return typeof alt === 'string' && alt.length > 0 ? alt.trim() : undefined;
}
