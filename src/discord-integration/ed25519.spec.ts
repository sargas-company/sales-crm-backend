import { describe, it, expect } from '@jest/globals';
import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
  createPublicKey,
} from 'node:crypto';

import { verifyDiscordSignature, isDiscordSnowflake } from './ed25519';

function hexOfRawPublic(pub: ReturnType<typeof createPublicKey>): string {
  // Export as SPKI DER, strip the 12-byte prefix → 32 raw bytes.
  const der = pub.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(der.length - 32).toString('hex');
}

function hexOfSignature(
  privateKey: ReturnType<typeof createPrivateKey>,
  message: Buffer,
): string {
  return sign(null, message, privateKey).toString('hex');
}

describe('verifyDiscordSignature — raw-body contract', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = hexOfRawPublic(publicKey);
  const timestamp = '1700000000';
  const rawBody = Buffer.from(
    JSON.stringify({ type: 1, id: 'abc', application_id: 'x' }),
    'utf8',
  );
  const signed = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
  const signatureHex = hexOfSignature(privateKey, signed);

  it('accepts a correctly signed message', () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex,
        timestamp,
        rawBody,
      }),
    ).toBe(true);
  });

  it('rejects when the body was mutated after signing', () => {
    const tampered = Buffer.concat([rawBody, Buffer.from(' ', 'utf8')]);
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex,
        timestamp,
        rawBody: tampered,
      }),
    ).toBe(false);
  });

  it('rejects on timestamp drift', () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex,
        timestamp: '1700000001',
        rawBody,
      }),
    ).toBe(false);
  });

  it('rejects an unknown signature (different key)', () => {
    const other = generateKeyPairSync('ed25519');
    const otherSig = hexOfSignature(other.privateKey, signed);
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex: otherSig,
        timestamp,
        rawBody,
      }),
    ).toBe(false);
  });

  it('rejects malformed hex / wrong byte length', () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex: 'zz',
        signatureHex,
        timestamp,
        rawBody,
      }),
    ).toBe(false);
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex: 'ab',
        timestamp,
        rawBody,
      }),
    ).toBe(false);
  });

  it('rejects on empty header fields', () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex: '',
        signatureHex,
        timestamp,
        rawBody,
      }),
    ).toBe(false);
  });
});

describe('isDiscordSnowflake', () => {
  it('accepts 17–20 digit numeric strings', () => {
    expect(isDiscordSnowflake('12345678901234567')).toBe(true);
    expect(isDiscordSnowflake('12345678901234567890')).toBe(true);
  });
  it('rejects short, non-numeric, or whitespace values', () => {
    expect(isDiscordSnowflake('abc')).toBe(false);
    expect(isDiscordSnowflake('123')).toBe(false);
    expect(isDiscordSnowflake(' 12345678901234567')).toBe(false);
    expect(isDiscordSnowflake(null)).toBe(false);
    expect(isDiscordSnowflake(undefined)).toBe(false);
  });
});
