import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MfaFactorType, Prisma } from '@prisma/client';
import { hash as bcryptHash, compare as bcryptCompare } from 'bcrypt';
import { randomBytes } from 'node:crypto';
import type {
  GenerateAuthenticationOptionsOpts,
  GenerateRegistrationOptionsOpts,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialEncryptionService } from './encryption.service';

// The two MFA libraries ship ESM-only sub-dependencies (`@scure/base` in
// otplib; various in @simplewebauthn). Jest with ts-jest only handles CJS
// by default, so we lazy-load these libs on first use — MfaService can be
// constructed by the DI container without dragging ESM into every spec.
type OtplibModule = typeof import('otplib');
type WebauthnModule = typeof import('@simplewebauthn/server');
let _otplib: OtplibModule | null = null;
let _webauthn: WebauthnModule | null = null;
async function loadOtplib(): Promise<OtplibModule> {
  if (!_otplib) _otplib = await import('otplib');
  return _otplib;
}
async function loadWebauthn(): Promise<WebauthnModule> {
  if (!_webauthn) _webauthn = await import('@simplewebauthn/server');
  return _webauthn;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RECOVERY_CODES = 10;
const RECOVERY_CODE_LEN_BYTES = 8;

/**
 * Handles the step-up MFA that gates the credential vault. Three factor
 * types are supported:
 *
 * • WebAuthn (passkeys): preferred. Uses `@simplewebauthn/server` for
 *   attestation on registration and assertion on unlock. Public keys +
 *   counters are stored per credential; the private key never leaves
 *   the authenticator.
 *
 * • TOTP: fallback for users without a passkey. Seed generated server
 *   side, encrypted at rest with the vault master key, presented once
 *   for the user to scan (issuer + label baked into the otpauth URL).
 *
 * • Recovery codes: 10 single-use codes shown once at generation.
 *   Stored server-side ONLY as bcrypt hashes; the plaintext never
 *   returns to disk.
 *
 * Challenges live in-memory (`_challenges`) — plain sliding-window map
 * keyed by userId, one active challenge per user per factor. Redis
 * upgrade is trivial (Phase 5).
 *
 * Never logs plaintext secrets, seeds, recovery codes or challenges.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private readonly _challenges = new Map<string, { value: string; expiresAt: number }>();

  private readonly totpParams = {
    algorithm: 'sha1' as const,
    digits: 6,
    period: 30,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: CredentialEncryptionService,
    private readonly config: ConfigService,
  ) {}

  // ─── Setup status ────────────────────────────────────────────────

  async statusFor(userId: string): Promise<MfaStatus> {
    const rows = await this.prisma.userMfaCredential.findMany({
      where: { userId },
      select: { type: true, deviceLabel: true, codeIndex: true, usedAt: true, createdAt: true, lastUsedAt: true },
    });
    const webauthn = rows.filter((r) => r.type === MfaFactorType.WEBAUTHN)
      .map((r) => ({ label: r.deviceLabel ?? 'Passkey', createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
    const totp = rows.find((r) => r.type === MfaFactorType.TOTP);
    const recoveryTotal = rows.filter((r) => r.type === MfaFactorType.RECOVERY).length;
    const recoveryLeft = rows.filter((r) => r.type === MfaFactorType.RECOVERY && !r.usedAt).length;
    return {
      hasAnyFactor: webauthn.length > 0 || !!totp,
      webauthn,
      hasTotp: !!totp,
      recoveryCodes: recoveryTotal > 0
        ? { total: recoveryTotal, remaining: recoveryLeft }
        : null,
    };
  }

  // ─── TOTP setup ──────────────────────────────────────────────────

  async beginTotpEnrollment(userId: string, userLabel: string) {
    const otplib = await loadOtplib();
    const secret = otplib.generateSecret();
    const otpauth = otplib.generateURI({
      issuer: this.rpName(),
      label: userLabel,
      secret,
      ...this.totpParams,
    });
    // Buffer the pending seed until the user confirms with a live code.
    // We stash it in the challenge map with a short TTL — never persisted
    // in plaintext.
    this.setChallenge(`totp-enroll:${userId}`, secret);
    return { secret, otpauth };
  }

  async completeTotpEnrollment(userId: string, code: string): Promise<void> {
    const secret = this.consumeChallenge(`totp-enroll:${userId}`);
    if (!secret) throw new BadRequestException('TOTP enrollment expired. Start again.');
    const otplib = await loadOtplib();
    if (!otplib.verifySync({ token: code, secret, ...this.totpParams }).valid) {
      // Restore the challenge so the user can retry — do not burn it on typo.
      this.setChallenge(`totp-enroll:${userId}`, secret);
      throw new BadRequestException('TOTP code invalid.');
    }
    const enc = this.enc.encryptBuffer(Buffer.from(secret, 'utf8'));
    await this.prisma.userMfaCredential.upsert({
      where: { id: `totp:${userId}` },
      create: {
        id: `totp:${userId}`,
        userId,
        type: MfaFactorType.TOTP,
        encTotpSeed: enc.ciphertext,
        totpIv: enc.iv,
        totpAuthTag: enc.authTag,
        totpKeyVersion: enc.keyVersion,
        totpAlgorithm: enc.algorithm,
      },
      update: {
        encTotpSeed: enc.ciphertext,
        totpIv: enc.iv,
        totpAuthTag: enc.authTag,
        totpKeyVersion: enc.keyVersion,
        totpAlgorithm: enc.algorithm,
      },
    });
  }

  /** Remove the user's TOTP enrollment, gated by a live code so a
   *  hijacked session can't disable MFA. The caller must prove they
   *  currently hold the authenticator before the row is deleted. */
  async removeTotp(userId: string, code: string): Promise<void> {
    const ok = await this.verifyTotp(userId, code);
    if (!ok) throw new BadRequestException('TOTP code invalid.');
    await this.prisma.userMfaCredential.deleteMany({
      where: { userId, type: MfaFactorType.TOTP },
    });
  }

  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const row = await this.prisma.userMfaCredential.findFirst({
      where: { userId, type: MfaFactorType.TOTP },
      select: {
        id: true,
        encTotpSeed: true,
        totpIv: true,
        totpAuthTag: true,
        totpKeyVersion: true,
        totpAlgorithm: true,
      },
    });
    if (!row?.encTotpSeed || !row.totpIv || !row.totpAuthTag) return false;
    const seedBuf = this.enc.decryptBuffer({
      ciphertext: row.encTotpSeed,
      iv: row.totpIv,
      authTag: row.totpAuthTag,
      keyVersion: row.totpKeyVersion ?? 1,
      algorithm: row.totpAlgorithm ?? 'AES-256-GCM',
    });
    const otplib = await loadOtplib();
    const ok = otplib.verifySync({
      token: code,
      secret: seedBuf.toString('utf8'),
      ...this.totpParams,
    }).valid;
    if (ok) {
      await this.prisma.userMfaCredential.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      });
    }
    return ok;
  }

  // ─── WebAuthn (passkeys) ─────────────────────────────────────────

  async beginPasskeyRegistration(userId: string, userLabel: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.prisma.userMfaCredential.findMany({
      where: { userId, type: MfaFactorType.WEBAUTHN },
      select: { credentialId: true, transports: true },
    });
    const opts: GenerateRegistrationOptionsOpts = {
      rpName: this.rpName(),
      rpID: this.rpID(),
      userID: Buffer.from(userId, 'utf8'),
      userName: userLabel,
      timeout: 60_000,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      excludeCredentials: existing
        .filter((e) => !!e.credentialId)
        .map((e) => ({
          id: Buffer.from(e.credentialId as Uint8Array).toString('base64url'),
          transports: (e.transports as AuthenticatorTransport[]) ?? undefined,
        })),
    };
    const options = await (await loadWebauthn()).generateRegistrationOptions(opts);
    this.setChallenge(`webauthn-reg:${userId}`, options.challenge);
    return options;
  }

  async completePasskeyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    deviceLabel?: string,
  ): Promise<void> {
    const expectedChallenge = this.consumeChallenge(`webauthn-reg:${userId}`);
    if (!expectedChallenge) throw new BadRequestException('WebAuthn challenge expired.');
    let verified: VerifiedRegistrationResponse;
    try {
      verified = await (await loadWebauthn()).verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.rpOrigin(),
        expectedRPID: this.rpID(),
      });
    } catch (err: unknown) {
      throw new BadRequestException(
        (err as Error).message || 'Passkey registration failed.',
      );
    }
    if (!verified.verified || !verified.registrationInfo) {
      throw new BadRequestException('Passkey registration not verified.');
    }
    const info = verified.registrationInfo;
    const credential = info.credential;
    await this.prisma.userMfaCredential.create({
      data: {
        userId,
        type: MfaFactorType.WEBAUTHN,
        credentialId: Buffer.from(credential.id, 'base64url'),
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: (credential.transports as string[]) ?? [],
        deviceLabel: deviceLabel?.slice(0, 60) ?? null,
      },
    });
  }

  async beginPasskeyAssertion(userId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const rows = await this.prisma.userMfaCredential.findMany({
      where: { userId, type: MfaFactorType.WEBAUTHN },
      select: { credentialId: true, transports: true },
    });
    if (rows.length === 0) {
      throw new BadRequestException('No passkeys registered for this user.');
    }
    const opts: GenerateAuthenticationOptionsOpts = {
      timeout: 60_000,
      rpID: this.rpID(),
      userVerification: 'preferred',
      allowCredentials: rows
        .filter((r) => !!r.credentialId)
        .map((r) => ({
          id: Buffer.from(r.credentialId as Uint8Array).toString('base64url'),
          transports: (r.transports as AuthenticatorTransport[]) ?? undefined,
        })),
    };
    const options = await (await loadWebauthn()).generateAuthenticationOptions(opts);
    this.setChallenge(`webauthn-assert:${userId}`, options.challenge);
    return options;
  }

  async completePasskeyAssertion(
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<boolean> {
    const expectedChallenge = this.consumeChallenge(`webauthn-assert:${userId}`);
    if (!expectedChallenge) throw new UnauthorizedException('Passkey challenge expired.');
    const credId = Buffer.from(response.id, 'base64url');
    const row = await this.prisma.userMfaCredential.findUnique({
      where: { credentialId: credId },
      select: {
        id: true,
        userId: true,
        publicKey: true,
        counter: true,
        transports: true,
      },
    });
    if (!row || row.userId !== userId || !row.publicKey) {
      throw new UnauthorizedException('Passkey unknown.');
    }
    let verified: VerifiedAuthenticationResponse;
    try {
      verified = await (await loadWebauthn()).verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.rpOrigin(),
        expectedRPID: this.rpID(),
        credential: {
          id: response.id,
          publicKey: row.publicKey,
          counter: Number(row.counter ?? 0n),
          transports: (row.transports as AuthenticatorTransport[]) ?? undefined,
        },
      });
    } catch (err: unknown) {
      throw new UnauthorizedException(
        (err as Error).message || 'Passkey verification failed.',
      );
    }
    if (!verified.verified) return false;
    await this.prisma.userMfaCredential.update({
      where: { id: row.id },
      data: {
        counter: BigInt(verified.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });
    return true;
  }

  // ─── Recovery codes ──────────────────────────────────────────────

  async issueRecoveryCodes(userId: string): Promise<string[]> {
    // Wipe any existing codes when a new batch is minted; the user must
    // print/store the new set.
    await this.prisma.userMfaCredential.deleteMany({
      where: { userId, type: MfaFactorType.RECOVERY },
    });
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODES; i++) {
      const raw = randomBytes(RECOVERY_CODE_LEN_BYTES).toString('base64url').slice(0, 12);
      const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`.toLowerCase();
      const hashed = await bcryptHash(formatted, 12);
      await this.prisma.userMfaCredential.create({
        data: {
          userId,
          type: MfaFactorType.RECOVERY,
          codeHash: hashed,
          codeIndex: i + 1,
        },
      });
      codes.push(formatted);
    }
    return codes;
  }

  async consumeRecoveryCode(userId: string, code: string): Promise<{ used: boolean; index?: number }> {
    const trimmed = code.trim().toLowerCase();
    const rows = await this.prisma.userMfaCredential.findMany({
      where: { userId, type: MfaFactorType.RECOVERY, usedAt: null },
      select: { id: true, codeHash: true, codeIndex: true },
    });
    for (const row of rows) {
      if (!row.codeHash) continue;
      if (await bcryptCompare(trimmed, row.codeHash)) {
        await this.prisma.userMfaCredential.update({
          where: { id: row.id },
          data: { usedAt: new Date(), lastUsedAt: new Date() },
        });
        return { used: true, index: row.codeIndex ?? undefined };
      }
    }
    return { used: false };
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private setChallenge(key: string, value: string): void {
    this._challenges.set(key, { value, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  }

  private consumeChallenge(key: string): string | null {
    const entry = this._challenges.get(key);
    if (!entry) return null;
    this._challenges.delete(key);
    if (entry.expiresAt < Date.now()) return null;
    return entry.value;
  }

  private rpName(): string {
    return this.config.get<string>('VAULT_RP_NAME') ?? 'Sargas CRM';
  }

  private rpID(): string {
    return this.config.get<string>('VAULT_RP_ID') ?? 'localhost';
  }

  private rpOrigin(): string {
    return (
      this.config.get<string>('VAULT_RP_ORIGIN') ??
      this.config.get<string>('CORS_ORIGIN_1') ??
      'http://localhost:5173'
    );
  }
}

export interface MfaStatus {
  hasAnyFactor: boolean;
  webauthn: Array<{ label: string; createdAt: Date; lastUsedAt: Date | null }>;
  hasTotp: boolean;
  recoveryCodes: { total: number; remaining: number } | null;
}
