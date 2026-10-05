import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Application-layer authenticated encryption for the Credentials vault.
 *
 * Contract:
 *   • Algorithm: AES-256-GCM (Node crypto — no home-grown primitives).
 *   • IV: 96 bits (12 bytes), fresh CSPRNG on every call.
 *   • Auth tag: 128 bits, verified on decrypt; tamper → throw.
 *   • Key version + algorithm string persisted per-row for future rotation.
 *
 * Keys are supplied via env (CREDENTIAL_VAULT_MASTER_KEY_V1 …), one env var
 * per version. On boot the service loads all present keys, remembers the
 * highest available version as the default for encryption, and keeps older
 * versions readable so an older row can still be decrypted after key rotation.
 *
 * Master keys are 32 raw bytes, encoded as base64 in env. They MUST NOT be
 * printed, logged, cached to files, echoed in errors or included in metrics.
 * Nothing in this class serialises `keyBytes` or `pool`.
 *
 * If no key is present in a `local`/`development` environment we DO NOT
 * generate one implicitly — that would silently corrupt state on next boot.
 * The service throws on construction so the operator sees the misconfigure.
 * See `.env.example` for the openssl command to generate one.
 */
@Injectable()
export class CredentialEncryptionService {
  private readonly logger = new Logger(CredentialEncryptionService.name);
  private readonly algorithm = 'AES-256-GCM';
  private readonly nodeCipherName = 'aes-256-gcm' as const;
  private readonly ivLen = 12;
  private readonly authTagLen = 16;
  private readonly keyLen = 32;

  private pool: Map<number, Buffer> | null = null;
  private currentVersion: number | null = null;
  private initialized = false;

  constructor(private readonly config: ConfigService) {}

  /**
   * Lazily discover CREDENTIAL_VAULT_MASTER_KEY_V<n> variables. We defer
   * initialization so the app can boot in dev without the key set — the
   * error only surfaces the first time a caller actually needs to encrypt
   * or decrypt. That keeps the vault fully self-contained and does not
   * block unrelated modules during local bootstrap.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    const pool = new Map<number, Buffer>();
    for (const [envKey, envVal] of Object.entries(process.env)) {
      const match = envKey.match(/^CREDENTIAL_VAULT_MASTER_KEY_V(\d+)$/);
      if (!match || !envVal) continue;
      const version = Number.parseInt(match[1]!, 10);
      const raw = this.parseKey(envKey, envVal);
      pool.set(version, raw);
    }
    if (pool.size === 0) {
      throw new InternalServerErrorException(
        'CredentialEncryptionService: no CREDENTIAL_VAULT_MASTER_KEY_V<n> ' +
          'variable is set. Generate one via `openssl rand -base64 32` and add ' +
          'CREDENTIAL_VAULT_MASTER_KEY_V1 to your .env before booting.',
      );
    }
    this.pool = pool;
    this.currentVersion = Math.max(...pool.keys());
    this.initialized = true;
    this.logger.log(
      `Credential vault ready — algorithm=${this.algorithm}, ` +
        `keys=${[...pool.keys()].sort().join(',')}, ` +
        `writing v${this.currentVersion}`,
    );
  }

  /**
   * Health probe for the config UI / diagnostic endpoints. Returns
   * `false` when the master key is not yet set; does NOT throw.
   */
  isConfigured(): boolean {
    try {
      this.ensureInitialized();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Encrypt an arbitrary UTF-8 JSON payload. Returns the ciphertext, IV,
   * auth tag, and the key version + algorithm string to persist alongside.
   */
  encryptJson(value: unknown): EncryptedRecord {
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    return this.encryptBuffer(plaintext);
  }

  /**
   * Encrypt raw bytes (used for attachment content / storage refs).
   */
  encryptBuffer(plaintext: Buffer): EncryptedRecord {
    this.ensureInitialized();
    const version = this.currentVersion!;
    const key = this.mustGetKey(version);
    const iv = randomBytes(this.ivLen);
    const cipher = createCipheriv(this.nodeCipherName, key, iv, {
      authTagLength: this.authTagLen,
    });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Copy through Buffer.from and expose as PrismaBytes so the record
    // is directly assignable to a `Bytes` column. Small buffers — cheap.
    return {
      ciphertext: Buffer.from(encrypted) as unknown as PrismaBytes,
      iv: Buffer.from(iv) as unknown as PrismaBytes,
      authTag: Buffer.from(authTag) as unknown as PrismaBytes,
      keyVersion: version,
      algorithm: this.algorithm,
    };
  }

  /**
   * Reverse of {@link encryptJson}. Any tamper of ciphertext / IV / tag
   * makes the decipher throw — surface as a sanitized error.
   */
  decryptJson<T = unknown>(record: EncryptedRecordInput): T {
    const raw = this.decryptBuffer(record);
    try {
      return JSON.parse(raw.toString('utf8')) as T;
    } catch {
      throw new InternalServerErrorException(
        'Credential payload decoded but did not parse as JSON.',
      );
    }
  }

  decryptBuffer(record: EncryptedRecordInput): Buffer {
    this.ensureInitialized();
    if (record.algorithm !== this.algorithm) {
      throw new InternalServerErrorException(
        `Unsupported credential algorithm '${record.algorithm}'.`,
      );
    }
    const key = this.mustGetKey(record.keyVersion);
    const decipher = createDecipheriv(this.nodeCipherName, key, record.iv, {
      authTagLength: this.authTagLen,
    });
    decipher.setAuthTag(record.authTag);
    try {
      return Buffer.concat([
        decipher.update(record.ciphertext),
        decipher.final(),
      ]);
    } catch {
      throw new InternalServerErrorException(
        'Credential payload failed authentication.',
      );
    }
  }

  /**
   * Constant-time comparison — small helper used by the recovery-code
   * flow so callers do not have to import node:crypto directly.
   */
  timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  getCurrentKeyVersion(): number {
    this.ensureInitialized();
    return this.currentVersion!;
  }

  private mustGetKey(version: number): Buffer {
    const key = this.pool?.get(version);
    if (!key) {
      throw new InternalServerErrorException(
        `Credential key version v${version} not loaded.`,
      );
    }
    return key;
  }

  private parseKey(envKey: string, raw: string): Buffer {
    // Accept base64 (preferred, 44 chars for 32 bytes) or hex (64 chars).
    // Anything else — refuse rather than silently derive weak material.
    const trimmed = raw.trim();
    let buf: Buffer | null = null;
    if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 40) {
      buf = Buffer.from(trimmed, 'base64');
    } else if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === 64) {
      buf = Buffer.from(trimmed, 'hex');
    }
    if (!buf || buf.length !== this.keyLen) {
      throw new InternalServerErrorException(
        `${envKey}: expected 32-byte key (base64 or hex). Generate via ` +
          '`openssl rand -base64 32`.',
      );
    }
    return buf;
  }
}

// Prisma's `Bytes` columns are typed as `Uint8Array<ArrayBuffer>` in
// TypeScript ≥ 5.7 / @types/node ≥ 22. Node crypto returns Buffers whose
// generic parameter is `ArrayBufferLike`, so a direct write from a fresh
// Buffer trips the strict type check. We publish the exact Prisma shape
// as the encrypt output type, and cast once inside `encryptBuffer`.
export type PrismaBytes = Uint8Array<ArrayBuffer>;

export interface EncryptedRecord {
  ciphertext: PrismaBytes;
  iv: PrismaBytes;
  authTag: PrismaBytes;
  keyVersion: number;
  algorithm: string;
}

export interface EncryptedRecordInput {
  // Decrypt input — accepts either Buffer (fresh from encrypt) or the
  // Uint8Array returned by Prisma. `createDecipheriv` accepts both.
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
  algorithm: string;
}
