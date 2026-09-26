import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PERMISSIONS_KEY = 'required_permissions';

/**
 * Attach one or more capability keys (e.g. 'prompts:view',
 * 'credentials:reveal') to a route handler. `PermissionGuard`
 * loads the caller's role permissions from the DB on every
 * request and rejects with 403 when any of the listed keys is
 * missing (AND semantics).
 *
 * Usage:
 *   @RequirePermission('prompts:view')
 *   @RequirePermission('roles:update', 'roles:assign')
 */
export const RequirePermission = (...keys: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, keys);
