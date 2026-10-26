import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/* Hard-denies portal (`isPortalUser === true`) actors on admin-only
 * controllers (share management, invite management, portal-user
 * management). Mounted BEFORE PermissionGuard so a portal user with
 * an implicit `file_manager:manage` grant cannot reach these routes.
 *
 * Reason this exists: PermissionGuard grants portal users
 * `file_manager:manage` so they can upload / rename / delete files
 * inside their shared scope. Those same permission keys protect
 * admin surfaces (grant share, create invite, list portal users),
 * which would be a privilege escalation. Rather than re-plumb the
 * permission catalogue, we add a cheap "no portal here" check at the
 * controller level and keep the file-ops `manage` grant intact. */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: { isPortalUser?: boolean } }>();
    if (req.user?.isPortalUser) {
      throw new ForbiddenException('Admin-only endpoint');
    }
    return true;
  }
}
