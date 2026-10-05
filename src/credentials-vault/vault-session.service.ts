import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';

const VAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour (fallback)
const TOKEN_BYTES = 32;

/**
 * Server-side vault-session lifecycle. The token is issued after the
 * user proves a fresh MFA challenge and lives in an opaque, HttpOnly,
 * SameSite cookie — never in localStorage, Redux, URL or JS-visible
 * memory. The DB row stores only the SHA-256 hash of the token so a DB
 * dump does not expose live vault access.
 *
 * Callers get a token issued through {@link issue}; they attach it to
 * the outgoing cookie. On every reveal / attachment / hard-delete the
 * guard calls {@link verify} to swap cookie → active session or 401.
 *
 * A vault session is bound to a specific User. `authSessionId` (JWT
 * session id when available) lets us close vault sessions when the
 * matching auth session ends. Explicit revoke reasons feed the audit
 * stream: `user_lock`, `logout`, `credential_change`, `expired`.
 */
@Injectable()
export class VaultSessionService {
  private readonly logger = new Logger(VaultSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  static readonly TTL_MS = VAULT_SESSION_TTL_MS;

  /** Returns the configured vault-session TTL in ms. Falls back to
   *  the 1-hour default when the Setting is missing / invalid. */
  private async currentTtlMs(): Promise<number> {
    const minutes = await this.settings.getNumberForKey(
      SK.CREDENTIALS_VAULT_SESSION_MIN,
      60,
    );
    const clamped = Math.min(240, Math.max(5, minutes));
    return clamped * 60 * 1000;
  }

  async issue(
    params: {
      userId: string;
      authSessionId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
    },
  ): Promise<IssuedVaultSession> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = hashToken(token);
    const ttlMs = await this.currentTtlMs();
    const expiresAt = new Date(Date.now() + ttlMs);
    const row = await this.prisma.vaultSession.create({
      data: {
        userId: params.userId,
        authSessionId: params.authSessionId ?? null,
        tokenHash,
        expiresAt,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      },
      select: { id: true, expiresAt: true },
    });
    return { id: row.id, token, expiresAt: row.expiresAt };
  }

  /**
   * Validate a bearer token from the cookie. Returns the vault-session
   * row (never the raw token) on success. On any failure (expired,
   * revoked, unknown, wrong user) throws 401.
   */
  async verify(params: {
    token: string;
    userId: string;
  }): Promise<ActiveVaultSession> {
    if (!params.token || typeof params.token !== 'string') {
      throw new UnauthorizedException('Vault session missing.');
    }
    const tokenHash = hashToken(params.token);
    const row = await this.prisma.vaultSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    if (!row) throw new UnauthorizedException('Vault session invalid.');
    if (row.userId !== params.userId) {
      throw new UnauthorizedException('Vault session mismatch.');
    }
    if (row.revokedAt) throw new UnauthorizedException('Vault session revoked.');
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Vault session expired.');
    }
    // Track last-used timestamp on a best-effort basis. A background
    // sweeper (Phase 5 cron) will remove ancient rows; here we just
    // bump the row so the UI's countdown is honest.
    await this.prisma.vaultSession
      .update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => this.logger.warn(`vault-session touch failed: ${err.message}`));
    return {
      id: row.id,
      userId: row.userId,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Return the current session for status endpoints. Never throws —
   * returns `null` when the token is missing / expired / revoked.
   */
  async peek(token: string | null | undefined, userId: string): Promise<ActiveVaultSession | null> {
    if (!token) return null;
    try {
      return await this.verify({ token, userId });
    } catch {
      return null;
    }
  }

  async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
    await this.prisma.vaultSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: RevokeReason): Promise<number> {
    const res = await this.prisma.vaultSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return res.count;
  }
}

export type RevokeReason =
  | 'user_lock'
  | 'logout'
  | 'credential_change'
  | 'expired'
  | 'mfa_reset';

export interface IssuedVaultSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export interface ActiveVaultSession {
  id: string;
  userId: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const VAULT_SESSION_COOKIE = 'vault_session';
