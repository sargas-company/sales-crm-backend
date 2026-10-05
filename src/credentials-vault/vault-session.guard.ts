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
    if (!token) throw new UnauthorizedException('Vault session missing');
    const session = await this.sessions.verify({
      token,
      userId: req.user.id,
    });
    req.vaultSession = session;
    return true;
  }
}
