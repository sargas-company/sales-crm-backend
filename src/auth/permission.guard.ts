import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PrismaService } from '../prisma/prisma.service';
import { REQUIRED_PERMISSIONS_KEY } from './permission.decorator';

/**
 * Capability-based authorization guard.
 *
 * On every protected request, loads the caller's role and its
 * permissions from the database and grants access only when every
 * key listed by `@RequirePermission(...)` is present. There is no
 * in-memory cache in this feature; the extra Prisma read per
 * request is the cost we accept for immediate revocation on
 * role / permission changes (see spec §2, §6, §7).
 *
 * On success the guard attaches the caller's granted key set to
 * `req.user.permissions: Set<string>`, so downstream service-layer
 * scope checks (e.g. `contractor_scope:view` on
 * counterparty/invoice reads) can consult it without an additional
 * DB round-trip.
 *
 * `JwtAuthGuard` MUST run first — this guard reads `req.user.id`
 * from the JWT strategy's `validate()` result.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredKeys = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No decorator on this handler → nothing to enforce.
    if (!requiredKeys || requiredKeys.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.id;
    if (!userId) {
      throw new ForbiddenException('Not authenticated');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        roleRef: {
          select: {
            permissions: {
              select: { permission: { select: { key: true } } },
            },
          },
        },
      },
    });

    // No role assigned → treat as no permissions (spec §6 edge case).
    if (!user?.roleRef) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const granted = new Set(
      user.roleRef.permissions.map((rp) => rp.permission.key),
    );
    const missing = requiredKeys.filter((k) => !granted.has(k));
    if (missing.length > 0) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // Expose the granted set so scope-sensitive services on the same
    // request can consult it without another DB read.
    if (req.user) req.user.permissions = granted;

    return true;
  }
}
