import { afterEach, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from './encryption.service';

// Sanity tests for the encryption primitive. These prove:
//   • encrypt → decrypt round-trips arbitrary JSON;
//   • tampering with ciphertext, IV or auth tag makes decrypt throw;
//   • an unknown key version is rejected instead of silently proceeding;
//   • v1 → v2 rotation: rows written under v1 remain readable after
//     v2 becomes the write key.

function fillTestKey(name: string, buf?: Buffer) {
  process.env[name] = (buf ?? randomBytes(32)).toString('base64');
}

function clearTestKeys() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CREDENTIAL_VAULT_MASTER_KEY_V')) {
      delete process.env[k];
    }
  }
}

describe('CredentialEncryptionService', () => {
  const saved = { ...process.env };

  afterEach(() => {
    clearTestKeys();
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith('CREDENTIAL_VAULT_MASTER_KEY_V') && v !== undefined) {
        process.env[k] = v;
      }
    }
  });

  it('reports unconfigured and throws only on first use when no key is set', () => {
    clearTestKeys();
    // Boot is intentionally lazy so the app can start without the key set.
    const svc = new CredentialEncryptionService({} as ConfigService);
    expect(svc.isConfigured()).toBe(false);
    expect(() => svc.encryptJson({ x: 1 })).toThrow(
      /CREDENTIAL_VAULT_MASTER_KEY/,
    );
  });

  it('round-trips a JSON payload', () => {
    clearTestKeys();
    fillTestKey('CREDENTIAL_VAULT_MASTER_KEY_V1');
    const svc = new CredentialEncryptionService({} as ConfigService);
    const original = {
      username: 'vadym',
      password: 'pw-🔐-12345',
      recovery: ['a', 'b', 'c'],
    };
    const rec = svc.encryptJson(original);
    expect(rec.algorithm).toBe('AES-256-GCM');
    expect(rec.keyVersion).toBe(1);
    expect(rec.iv.length).toBe(12);
    expect(rec.authTag.length).toBe(16);
    const back = svc.decryptJson<typeof original>(rec);
    expect(back).toEqual(original);
  });

  it('rejects a tampered ciphertext', () => {
    clearTestKeys();
    fillTestKey('CREDENTIAL_VAULT_MASTER_KEY_V1');
    const svc = new CredentialEncryptionService({} as ConfigService);
    const rec = svc.encryptJson({ secret: 'do-not-leak' });
    rec.ciphertext[0] ^= 0xff;
    expect(() => svc.decryptJson(rec)).toThrow(/failed authentication/);
  });

  it('rejects a tampered auth tag', () => {
    clearTestKeys();
    fillTestKey('CREDENTIAL_VAULT_MASTER_KEY_V1');
    const svc = new CredentialEncryptionService({} as ConfigService);
    const rec = svc.encryptJson({ secret: 'do-not-leak' });
    rec.authTag[0] ^= 0x01;
    expect(() => svc.decryptJson(rec)).toThrow(/failed authentication/);
  });

  it('rejects a swapped IV', () => {
    clearTestKeys();
    fillTestKey('CREDENTIAL_VAULT_MASTER_KEY_V1');
    const svc = new CredentialEncryptionService({} as ConfigService);
    const a = svc.encryptJson({ id: 1 });
    const b = svc.encryptJson({ id: 2 });
    a.iv = b.iv; // swap ivs between two different ciphertexts
    expect(() => svc.decryptJson(a)).toThrow(/failed authentication/);
  });

  it('rejects an unknown key version', () => {
    clearTestKeys();
    fillTestKey('CREDENTIAL_VAULT_MASTER_KEY_V1');
    const svc = new CredentialEncryptionService({} as ConfigService);
    const rec = svc.encryptJson({ ok: true });
    rec.keyVersion = 99;
    expect(() => svc.decryptJson(rec)).toThrow(/v99 not loaded/);
  });

  it('reads a v1 row after v2 becomes the write key', () => {
    clearTestKeys();
    fillTestKey('CREDENTIAL_VAULT_MASTER_KEY_V1');
    const v1Only = new CredentialEncryptionService({} as ConfigService);
    const v1Row = v1Only.encryptJson({ tag: 'old' });
    expect(v1Row.keyVersion).toBe(1);

    fillTestKey('CREDENTIAL_VAULT_MASTER_KEY_V2');
    const rotated = new CredentialEncryptionService({} as ConfigService);
    expect(rotated.getCurrentKeyVersion()).toBe(2);

    // Old row still readable.
    expect(rotated.decryptJson<{ tag: string }>(v1Row)).toEqual({ tag: 'old' });

    // New writes use v2.
    const v2Row = rotated.encryptJson({ tag: 'new' });
    expect(v2Row.keyVersion).toBe(2);
    expect(rotated.decryptJson<{ tag: string }>(v2Row)).toEqual({ tag: 'new' });
  });
});
