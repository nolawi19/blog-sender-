import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ConfigurationError } from '../errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'enc';

/**
 * AES-256-GCM envelope for secrets at rest.
 * Format: enc:<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>
 * The key id makes rotation possible: new data is encrypted with the current key,
 * old rows remain readable as long as their key is passed in `previousKeys`.
 */
export class CredentialCipher {
  private readonly keys: Map<string, Buffer>;

  constructor(
    private readonly currentKey: Buffer,
    private readonly currentKeyId = 'v1',
    previousKeys: Record<string, Buffer> = {},
  ) {
    if (currentKey.length !== 32) throw new ConfigurationError('Encryption key must be 32 bytes');
    this.keys = new Map(Object.entries(previousKeys));
    this.keys.set(currentKeyId, currentKey);
  }

  get keyId(): string {
    return this.currentKeyId;
  }

  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.currentKey, iv, { authTagLength: TAG_BYTES });
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, this.currentKeyId, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
  }

  decrypt(payload: string, aad?: string): string {
    const parts = payload.split(':');
    if (parts.length !== 5 || parts[0] !== PREFIX) throw new ConfigurationError('Malformed encrypted payload');
    const [, keyId, ivB64, tagB64, dataB64] = parts as [string, string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new ConfigurationError(`No decryption key available for key id "${keyId}"`);
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'), { authTagLength: TAG_BYTES });
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // Never include key material or ciphertext in the error.
      throw new ConfigurationError('Unable to decrypt credential (wrong key or tampered data)');
    }
  }

  encryptJson(value: Record<string, unknown>): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson(payload: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(this.decrypt(payload));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigurationError('Decrypted credential is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  }
}

/** Shapes of decrypted credential data per provider. */
export const credentialSchemas = {
  telegram: z.object({ botToken: z.string().regex(/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/, 'invalid Telegram bot token format') }),
  http: z.object({ headers: z.record(z.string(), z.string()).default({}) }),
} as const;

export type CredentialProvider = keyof typeof credentialSchemas;

export function isKnownProvider(provider: string): provider is CredentialProvider {
  return Object.hasOwn(credentialSchemas, provider);
}

export interface DecryptedCredential {
  id: string;
  name: string;
  provider: string;
  data: Record<string, unknown>;
}
