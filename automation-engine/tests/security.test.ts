import { describe, expect, it } from 'vitest';
import { parseEncryptionKey } from '../src/config.js';
import { ConfigurationError } from '../src/errors.js';
import { CredentialCipher } from '../src/security/credentials.js';
import { extractBearerToken, hashToken, signPayload, verifySignature, verifyToken } from '../src/security/hmac.js';
import { redactSecrets } from '../src/security/redact.js';
import { assertSafeUrl, isPrivateAddress } from '../src/security/ssrf.js';
import { BOT_TOKEN } from './helpers/fixtures.js';

const secret = 'super-secret-signing-key';
const body = Buffer.from('{"title":"hello"}');

describe('HMAC webhook signatures', () => {
  const now = 1_700_000_000;
  const signed = (ts = now, payload: Buffer = body, key = secret) => signPayload(key, ts, payload);

  it('accepts a valid signature', () => {
    expect(verifySignature({ secret, rawBody: body, signatureHeader: signed(), timestampHeader: String(now), toleranceSec: 300, nowSec: now })).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const result = verifySignature({ secret, rawBody: Buffer.from('{"title":"HELLO"}'), signatureHeader: signed(), timestampHeader: String(now), toleranceSec: 300, nowSec: now });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature made with another secret', () => {
    const result = verifySignature({ secret, rawBody: body, signatureHeader: signed(now, body, 'other'), timestampHeader: String(now), toleranceSec: 300, nowSec: now });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects replays outside the tolerance window', () => {
    const old = now - 301;
    const result = verifySignature({ secret, rawBody: body, signatureHeader: signed(old), timestampHeader: String(old), toleranceSec: 300, nowSec: now });
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('binds the timestamp into the MAC', () => {
    const result = verifySignature({ secret, rawBody: body, signatureHeader: signed(now), timestampHeader: String(now + 1), toleranceSec: 300, nowSec: now });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('reports missing and malformed headers', () => {
    const base = { secret, rawBody: body, toleranceSec: 300, nowSec: now };
    expect(verifySignature({ ...base, signatureHeader: undefined, timestampHeader: String(now) })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifySignature({ ...base, signatureHeader: signed(), timestampHeader: undefined })).toEqual({ ok: false, reason: 'missing_timestamp' });
    expect(verifySignature({ ...base, signatureHeader: signed(), timestampHeader: 'yesterday' })).toEqual({ ok: false, reason: 'invalid_timestamp' });
    expect(verifySignature({ ...base, signatureHeader: 'md5=abc', timestampHeader: String(now) })).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('accepts any of several signatures (secret rotation)', () => {
    const header = `${signed(now, body, 'old-secret')}, ${signed()}`;
    expect(verifySignature({ secret, rawBody: body, signatureHeader: header, timestampHeader: String(now), toleranceSec: 300, nowSec: now }).ok).toBe(true);
  });
});

describe('bearer token authentication', () => {
  it('verifies tokens against their stored SHA-256 hash', () => {
    const hash = hashToken('token-123');
    expect(verifyToken('token-123', hash)).toBe(true);
    expect(verifyToken('token-124', hash)).toBe(false);
    expect(verifyToken(undefined, hash)).toBe(false);
    expect(verifyToken('token-123', null)).toBe(false);
    expect(verifyToken('token-123', 'not-a-hash')).toBe(false);
  });

  it('extracts tokens from Authorization or X-Webhook-Token', () => {
    expect(extractBearerToken({ authorization: 'Bearer abc' })).toBe('abc');
    expect(extractBearerToken({ authorization: 'bearer   abc  ' })).toBe('abc');
    expect(extractBearerToken({ 'x-webhook-token': 'xyz' })).toBe('xyz');
    expect(extractBearerToken({ authorization: 'Basic abc' })).toBeUndefined();
  });
});

describe('credential encryption', () => {
  const key = parseEncryptionKey('0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0');

  it('round-trips JSON secrets and never stores plaintext', () => {
    const cipher = new CredentialCipher(key);
    const payload = cipher.encryptJson({ botToken: BOT_TOKEN });
    expect(payload.startsWith('enc:v1:')).toBe(true);
    expect(payload).not.toContain(BOT_TOKEN);
    expect(cipher.decryptJson(payload)).toEqual({ botToken: BOT_TOKEN });
  });

  it('uses a fresh IV for every encryption', () => {
    const cipher = new CredentialCipher(key);
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('detects tampering and wrong keys', () => {
    const cipher = new CredentialCipher(key);
    const payload = cipher.encrypt('secret');
    const parts = payload.split(':');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow(ConfigurationError);
    const other = new CredentialCipher(Buffer.alloc(32, 7));
    expect(() => other.decrypt(payload)).toThrow(/Unable to decrypt/);
  });

  it('supports key rotation through previous keys', () => {
    const oldCipher = new CredentialCipher(key, 'v1');
    const payload = oldCipher.encrypt('rotated');
    const rotated = new CredentialCipher(Buffer.alloc(32, 9), 'v2', { v1: key });
    expect(rotated.decrypt(payload)).toBe('rotated');
    expect(rotated.encrypt('x').startsWith('enc:v2:')).toBe(true);
  });

  it('validates encryption key formats', () => {
    expect(parseEncryptionKey(Buffer.alloc(32, 1).toString('base64')).length).toBe(32);
    expect(() => parseEncryptionKey('too-short')).toThrow(/32 bytes/);
  });
});

describe('secret redaction', () => {
  it('removes Telegram tokens, bearer tokens and signatures from strings', () => {
    const text = `POST https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed; token=${BOT_TOKEN}; Authorization: Bearer abc.def; sig sha256=${'a'.repeat(64)}`;
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain(BOT_TOKEN);
    expect(redacted).not.toContain('abc.def');
    expect(redacted).not.toContain('a'.repeat(64));
    expect(redacted).toContain('/bot[REDACTED]/sendMessage');
  });
});

describe('SSRF protection', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])(
    'blocks %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '1.1.1.1', '149.154.167.220', '2606:4700:4700::1111'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('rejects unsafe URLs', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/not allowed/);
    await expect(assertSafeUrl('http://user:pass@example.com')).rejects.toThrow(/Credentials/);
    await expect(assertSafeUrl('http://localhost:8080/')).rejects.toThrow(/not allowed/);
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or reserved/);
    await expect(assertSafeUrl('http://[::1]/')).rejects.toThrow(/private or reserved/);
    await expect(assertSafeUrl('https://internal.example.com', { resolve: async () => ['10.0.0.5'] })).rejects.toThrow(/private or reserved/);
  });

  it('accepts public URLs', async () => {
    const url = await assertSafeUrl('https://hooks.example.com/x', { resolve: async () => ['93.184.216.34'] });
    expect(url.hostname).toBe('hooks.example.com');
  });

  it('can be disabled explicitly for private deployments', async () => {
    await expect(assertSafeUrl('http://10.0.0.5/', { allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
  });
});
