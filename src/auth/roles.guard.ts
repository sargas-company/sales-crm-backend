import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ROLES_KEY } from './roles.decorator';

/**
 * Legacy role guard kept in place for `settings` / `telegram-auth`
 * until Legacy Cleanup drops the `UserRole` enum. Since the JWT
 * now carries identity only (spec §2), the guard resolves the
 * caller's legacy enum role from the DB on every protected
 * request — same policy as `PermissionGuard`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles) return true;

    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.id;
    if (!userId) return false;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user?.role) return false;
    return requiredRoles.includes(user.role);
  }
}
