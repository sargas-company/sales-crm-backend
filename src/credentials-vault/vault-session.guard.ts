import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthUser } from '../auth/auth-user';
import {
  ActiveVaultSession,
  VAULT_SESSION_COOKIE,
  VaultSessionService,
} from './vault-session.service';

/**
 * Requires an active, non-expired VaultSession bound to the current
 * user. Placed AFTER `JwtAuthGuard` + `PermissionGuard` on any endpoint
 * that returns decrypted secrets. Never bypasses PermissionGuard —
 * a caller without `credentials:reveal` still hits 403 first.
 *
 * On success the resolved session is stashed at
 * `req.vaultSession` for downstream handlers that want to audit the
 * session id.
 */
@Injectable()
export class VaultSessionGuard implements CanActivate {
  constructor(private readonly sessions: VaultSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & {
      user?: AuthUser;
      cookies?: Record<string, string | undefined>;
      vaultSession?: ActiveVaultSession;
    }>();
    if (!req.user?.id) {
      throw new UnauthorizedException('Not authenticated');
    }
    const token = req.cookies?.[VAULT_SESSION_COOKIE];
    if (!token) throw vaultSessionRequired('Vault session missing');
    try {
      const session = await this.sessions.verify({
        token,
        userId: req.user.id,
      });
      req.vaultSession = session;
      return true;
    } catch (err) {
      // Any failure from .verify (expired, revoked, user mismatch,
      // tampered token) collapses to the single "step-up required"
      // signal the frontend understands — the specifics live in the
      // audit log, not in the HTTP body.
      throw vaultSessionRequired(
        err instanceof Error ? err.message : 'Vault session invalid',
      );
    }
  }
}

/**
 * Distinguishable 401 so the frontend can tell "vault locked / needs
 * step-up" apart from "app JWT expired / login again". The frontend
 * baseApi interceptor keys off `code === 'VAULT_SESSION_REQUIRED'`
 * to pop the unlock drawer in place rather than kicking the user to
 * the sign-in page.
 */
function vaultSessionRequired(message: string): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: 'VAULT_SESSION_REQUIRED',
    message,
  });
}
