import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/* Rejects the request if the authenticated user is marked
 * `active=false` on the User row. Used in combination with
 * JwtAuthGuard — JWT establishes identity, this guard enforces
 * that the identity hasn't been terminated by an admin.
 *
 * Owner-approved semantics: admin flips User.active=false → on the
 * next request within the JWT TTL (15 min) the portal worker is
 * kicked with 403. No session blacklist, we rely on short JWT TTL. */
@Injectable()
export class ActiveUserGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const userId: string | undefined = req?.user?.id;
    if (!userId) return true; // let JwtAuthGuard handle missing auth
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { active: true },
    });
    if (!row || row.active === false) {
      throw new ForbiddenException('Account deactivated');
    }
    return true;
  }
}
