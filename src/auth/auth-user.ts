import { ForbiddenException } from '@nestjs/common';
import { CounterpartyType } from '@prisma/client';

/**
 * The request-scoped identity a service method receives. `id` is
 * always present (set by `JwtStrategy.validate`). `permissions` is
 * present when the route is behind `PermissionGuard`, which is
 * every business route — see the authorization contract test.
 */
export interface AuthUser {
  id: string;
  permissions: Set<string>;
}

const CONTRACTOR_VIEW = 'contractor_scope:view';
const CONTRACTOR_MANAGE = 'contractor_scope:manage';

/**
 * Utilities that translate contractor-scope permissions into
 * counterparty-type predicates.
 */
export const scopePolicy = {
  canViewContractor: (user: AuthUser): boolean =>
    user.permissions.has(CONTRACTOR_VIEW) ||
    user.permissions.has(CONTRACTOR_MANAGE),

  canManageContractor: (user: AuthUser): boolean =>
    user.permissions.has(CONTRACTOR_MANAGE),

  /** Counterparty types the caller may read (list + get). */
  visibleTypes: (user: AuthUser): CounterpartyType[] =>
    scopePolicy.canViewContractor(user) ? ['client', 'contractor'] : ['client'],

  /**
   * Throws 403 when the caller lacks the permission to READ a row
   * of `type`. Client rows are readable for anyone with the base
   * `<resource>:view` (already enforced by `@RequirePermission`).
   */
  assertCanReadType: (user: AuthUser, type: CounterpartyType): void => {
    if (type === 'contractor' && !scopePolicy.canViewContractor(user)) {
      throw new ForbiddenException('CONTRACTOR_SCOPE_REQUIRED');
    }
  },

  /**
   * Throws 403 when the caller lacks the permission to MUTATE a row
   * of `type` (create / update / delete / generate). Client rows
   * are managed by anyone holding the base `<resource>:*` action.
   */
  assertCanManageType: (user: AuthUser, type: CounterpartyType): void => {
    if (type === 'contractor' && !scopePolicy.canManageContractor(user)) {
      throw new ForbiddenException('CONTRACTOR_SCOPE_REQUIRED');
    }
  },
};
