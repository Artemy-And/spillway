import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A code to click or type from the logs, without look-alike letters: 60 random bits. */
export function newSetupCode(): string {
  const chars = [...randomBytes(12)].map((byte) => CODE_LETTERS[byte % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Compares a code the way people type it: any case, with or without dashes and spaces. */
export function sameCode(given: string | undefined, expected: string): boolean {
  const plain = (code: string) => Buffer.from(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const a = plain(given ?? '');
  const b = plain(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Gateway keys are shown once; only their hash is stored. */
export function newGatewayKey(): { key: string; prefix: string; hash: string } {
  const key = `sw-${randomToken(24)}`;
  return { key, prefix: key.slice(0, 9), hash: sha256(key) };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** AES-256-GCM for provider API keys at rest. */
export class Vault {
  #key: Buffer;

  constructor(secret: string) {
    this.#key = Buffer.from(hkdfSync('sha256', secret, 'spillway', 'provider-keys', 32));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  decrypt(sealed: string): string {
    const raw = Buffer.from(sealed.replace(/^v1:/, ''), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/** Uses SPILLWAY_SECRET, or a secret generated once into the data directory. */
export function loadSecret(fromEnv: string | undefined, dataDir: string): string {
  if (fromEnv) return fromEnv;
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomToken(48);
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
