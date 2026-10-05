import { createPublicKey, verify } from 'node:crypto';

/**
 * Verify the Ed25519 signature Discord puts on every interactions
 * request. The signed payload is `timestamp + raw body` — raw body
 * must NOT be re-serialised; Nest's default JSON parser hands back
 * a parsed object, so the interactions controller captures the raw
 * body in a `raw-body`-style buffer first and passes it here.
 *
 * `publicKeyHex` is the application's public key, printed in the
 * Discord Developer Portal. Store it in env as `DISCORD_PUBLIC_KEY`.
 *
 * Returns `true` iff the signature is valid, `false` otherwise.
 * Any thrown error (invalid hex, wrong byte count, non-key payload)
 * returns `false` — the caller rejects with HTTP 401 either way.
 */
export function verifyDiscordSignature(args: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  rawBody: Buffer | string;
}): boolean {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = args;
  if (!publicKeyHex || !signatureHex || !timestamp) return false;

  let publicKeyRaw: Buffer;
  let signature: Buffer;
  try {
    publicKeyRaw = Buffer.from(publicKeyHex, 'hex');
    signature = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  if (publicKeyRaw.length !== 32 || signature.length !== 64) return false;

  // SPKI envelope for a raw 32-byte Ed25519 public key.
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const spki = Buffer.concat([spkiPrefix, publicKeyRaw]);

  let key;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    return false;
  }

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const signed = Buffer.concat([Buffer.from(timestamp, 'utf8'), body]);
  try {
    return verify(null, signed, key, signature);
  } catch {
    return false;
  }
}

/**
 * Discord snowflake IDs are 17-20 digit numeric strings. We use the
 * same validator for channel, guild, role and user IDs.
 */
export function isDiscordSnowflake(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9]{17,20}$/.test(value)
  );
}
