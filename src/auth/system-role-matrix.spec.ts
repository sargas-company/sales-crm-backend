import { describe, it, expect } from '@jest/globals';

import {
  ADMIN_MANAGER_PRESET_KEYS,
  REGULAR_MANAGER_PRESET_KEYS,
  SYSTEM_ROLE_NAMES,
} from './system-role-presets';

/*
 * System-role preset matrix test — enforces the product policy for
 * the three built-in roles directly against the exported preset
 * module.
 *
 * The preset module is pure data (no DB access, no Nest DI); the
 * Prisma seed imports the same symbols. If the matrix drifts in
 * either direction this test fails first.
 */

/** Expected permissions for Admin Manager per the policy matrix. */
const ADMIN_EXPECTED = new Set<string>([
  'sales_analytics:view',

  'platforms:view', 'platforms:create', 'platforms:update', 'platforms:delete',
  'accounts:view', 'accounts:create', 'accounts:update', 'accounts:delete',

  'job_posts:view', 'job_posts:delete', 'job_posts:convert',

  'leads:view', 'leads:create', 'leads:update', 'leads:delete',
  'client_calls:view', 'client_calls:create', 'client_calls:update', 'client_calls:delete',
  'client_requests:view', 'client_requests:update', 'client_requests:delete',
  'proposals:view', 'proposals:update', 'proposals:delete',

  // Client invoices + client counterparties only. Contractor scope is
  // explicitly denied; service-level `scopePolicy` enforces that.
  'invoices:view', 'invoices:create', 'invoices:update', 'invoices:delete', 'invoices:generate',
  'counterparties:view', 'counterparties:create', 'counterparties:update', 'counterparties:delete',

  'prompts:view', 'prompts:create', 'prompts:update', 'prompts:delete',
  'employees:view',

  'projects:view', 'projects:create', 'projects:update', 'projects:delete', 'projects:view_any',
  'project_reports:view', 'project_reports:create', 'project_reports:update', 'project_reports:delete',

  'time_off:view', 'time_off:create', 'time_off:update', 'time_off:delete',

  'employee_analytics:view',
  'project_analytics:view',

  'linkedin_accounts:view', 'linkedin_accounts:create', 'linkedin_accounts:update', 'linkedin_accounts:delete',
  'linkedin_ideas:view',    'linkedin_ideas:create',    'linkedin_ideas:update',    'linkedin_ideas:delete',
  'linkedin_posts:view',    'linkedin_posts:create',    'linkedin_posts:update',    'linkedin_posts:delete',

  'credentials:view',
  'credentials:create',
  'credentials:update',
  'credentials:archive',
  'credentials:reveal',
  'credentials:attachments',
  'credential_audit:view',

  'phone_numbers:view',
  'phone_numbers:create',
  'phone_numbers:update',
  'phone_numbers:delete',
  'phone_numbers:maintain',

  'portfolio:view',
  'portfolio:create',
  'portfolio:update',
  'portfolio:delete',
  'portfolio:export',

  'notifications:view',
]);

/** Permissions Admin Manager MUST NOT hold per the matrix. */
const ADMIN_FORBIDDEN = new Set<string>([
  // Settings — now ENTIRELY off-limits for Admin Manager.
  'settings:view', 'settings:update',
  'settings_scanner:update', 'settings_invoicing:update',
  // Finance block.
  'finances_weekly:view', 'finances_weekly:edit',
  'finances:view', 'finances:create', 'finances:update', 'finances:delete',
  'cashflow:view', 'profit:view',
  'payment_sources:view', 'payment_sources:create', 'payment_sources:update', 'payment_sources:delete',
  'salaries:view', 'salaries:create', 'salaries:update', 'salaries:delete', 'salaries:reopen',
  'compensation_reviews:view', 'compensation_reviews:create', 'compensation_reviews:update', 'compensation_reviews:delete',
  'compensation_analytics:view',
  'finance_analytics:view',
  // Contractor scope.
  'contractor_scope:view', 'contractor_scope:manage',
  // Owner-only administration.
  'roles:view', 'roles:create', 'roles:update', 'roles:delete', 'roles:assign',
  'credentials:hard_delete',
  'backups:view', 'backups:create', 'backups:download',
  // Employees mutation stays Owner.
  'employees:create', 'employees:update', 'employees:delete',
  // Discord integration — Owner-only.
  'discord_integration:view', 'discord_integration:configure',
  'discord_integration:send_test', 'discord_integration:activate_profile',
]);

/** Regular Manager must be strictly read-only on projects + reports. */
const REGULAR_EXPECTED = new Set<string>([
  'projects:view',
  'project_reports:view',
]);

const REGULAR_FORBIDDEN = new Set<string>([
  'projects:view_any',
  'projects:create', 'projects:update', 'projects:delete',
  'project_reports:create', 'project_reports:update', 'project_reports:delete',
  // Spot-check across other modules — nothing should bleed into
  // Regular Manager's default surface.
  'leads:view', 'invoices:view', 'counterparties:view', 'employees:view',
  'credentials:view', 'phone_numbers:view', 'portfolio:view',
  'settings:view', 'settings:update',
  'audit_logs:view', 'backups:view', 'backups:download',
  'salaries:view', 'salaries:reopen',
  'finances_weekly:view', 'linkedin_posts:view',
  // Notification Bell / Notifications pages must stay hidden for
  // Regular Manager — the workspace feed can surface items from
  // modules they are not allowed to see.
  'notifications:view',
  // Discord integration is Owner-only.
  'discord_integration:view',
  'discord_integration:configure',
  'discord_integration:send_test',
  'discord_integration:activate_profile',
]);

describe('System-role preset matrix', () => {
  it('exposes exactly the three canonical system role names', () => {
    expect([...SYSTEM_ROLE_NAMES].sort()).toEqual(
      ['admin_manager', 'owner', 'regular_manager'],
    );
  });

  it('Admin Manager preset matches the operational matrix exactly', () => {
    const missing = [...ADMIN_EXPECTED].filter(
      (k) => !ADMIN_MANAGER_PRESET_KEYS.has(k),
    );
    const extra = [...ADMIN_MANAGER_PRESET_KEYS].filter(
      (k) => !ADMIN_EXPECTED.has(k),
    );
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('Admin Manager preset contains none of the forbidden keys', () => {
    const leaked = [...ADMIN_FORBIDDEN].filter((k) =>
      ADMIN_MANAGER_PRESET_KEYS.has(k),
    );
    expect(leaked).toEqual([]);
  });

  it('Admin Manager preset carries NO settings:* permission', () => {
    const settingsLeak = [...ADMIN_MANAGER_PRESET_KEYS].filter((k) =>
      k.startsWith('settings:') || k.startsWith('settings_'),
    );
    expect(settingsLeak).toEqual([]);
  });

  it('Regular Manager preset is exactly projects + project_reports view-only', () => {
    const missing = [...REGULAR_EXPECTED].filter(
      (k) => !REGULAR_MANAGER_PRESET_KEYS.has(k),
    );
    const extra = [...REGULAR_MANAGER_PRESET_KEYS].filter(
      (k) => !REGULAR_EXPECTED.has(k),
    );
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('Regular Manager preset contains none of the forbidden keys', () => {
    const leaked = [...REGULAR_FORBIDDEN].filter((k) =>
      REGULAR_MANAGER_PRESET_KEYS.has(k),
    );
    expect(leaked).toEqual([]);
  });

  describe('backups:download — Owner-only guarantee', () => {
    // Owner's RolePermission set is a full-sync against the catalogue
    // on every seed run — if `backups:download` is in the catalogue,
    // Owner carries it. The catalogue entry is covered by the seed
    // and by the dedicated 20261022000000 migration; the forbidden
    // list below is what keeps the two manager roles from ever
    // acquiring it, now or on a future preset refresh.
    it('is NOT in Admin Manager preset', () => {
      expect(ADMIN_MANAGER_PRESET_KEYS.has('backups:download')).toBe(false);
    });
    it('is NOT in Regular Manager preset', () => {
      expect(REGULAR_MANAGER_PRESET_KEYS.has('backups:download')).toBe(false);
    });
    it('is listed in the Admin / Regular forbidden sets', () => {
      expect(ADMIN_FORBIDDEN.has('backups:download')).toBe(true);
      expect(REGULAR_FORBIDDEN.has('backups:download')).toBe(true);
    });
  });
});
