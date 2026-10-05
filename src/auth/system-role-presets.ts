/**
 * System role preset matrix — the operational baseline for the three
 * built-in roles. This module is deliberately side-effect-free: it
 * exports pure constants and is safe to import from the Prisma seed,
 * from Nest services, and from unit tests.
 *
 * The policy expressed here is the source of truth. The seed syncs
 * each system role's bindings to the matching preset on every run;
 * custom roles created through the Roles UI are never touched.
 *
 * Owner is NOT listed here: Owner always carries the full catalogue
 * (every row in `Permission`), which the seed applies independently.
 */

/**
 * Admin Manager — operational access without finance, salary,
 * contractor scope, backups, roles administration, hard-delete of
 * credentials, or ANY Settings access. The Settings menu stays
 * entirely hidden from this role.
 */
export const ADMIN_MANAGER_PRESET_KEYS: ReadonlySet<string> = new Set<string>([
  // Sales Analytics — view.
  'sales_analytics:view',

  // Platforms — full CRUD.
  'platforms:view',
  'platforms:create',
  'platforms:update',
  'platforms:delete',

  // Accounts — full CRUD.
  'accounts:view',
  'accounts:create',
  'accounts:update',
  'accounts:delete',

  // Job Posts — view + delete + convert (no manual create / update:
  // posts arrive through the ingestion webhook).
  'job_posts:view',
  'job_posts:delete',
  'job_posts:convert',

  // Leads — full CRUD.
  'leads:view',
  'leads:create',
  'leads:update',
  'leads:delete',

  // Client Calls — full CRUD.
  'client_calls:view',
  'client_calls:create',
  'client_calls:update',
  'client_calls:delete',

  // Client Requests — view / update / delete (POST is public inbound).
  'client_requests:view',
  'client_requests:update',
  'client_requests:delete',

  // Proposals — view / update / delete (create via Job-Post convert).
  'proposals:view',
  'proposals:update',
  'proposals:delete',

  // Client invoices — full CRUD + generate. Service layer blocks
  // contractor-type rows because contractor_scope:* is not granted.
  'invoices:view',
  'invoices:create',
  'invoices:update',
  'invoices:delete',
  'invoices:generate',

  // Client counterparties — full CRUD. Contractor rows filtered at
  // the service layer.
  'counterparties:view',
  'counterparties:create',
  'counterparties:update',
  'counterparties:delete',

  // Prompts — full CRUD.
  'prompts:view',
  'prompts:create',
  'prompts:update',
  'prompts:delete',

  // Employees — view-only (lifecycle stays Owner-only).
  'employees:view',

  // Projects + reports — full CRUD plus view_any elevator.
  'projects:view',
  'projects:create',
  'projects:update',
  'projects:delete',
  'projects:view_any',
  'project_reports:view',
  'project_reports:create',
  'project_reports:update',
  'project_reports:delete',

  // Time Off — full CRUD.
  'time_off:view',
  'time_off:create',
  'time_off:update',
  'time_off:delete',

  // Operational analytics (view-only).
  'employee_analytics:view',
  'project_analytics:view',

  // LinkedIn workspace — full CRUD across accounts, ideas, posts.
  'linkedin_accounts:view',
  'linkedin_accounts:create',
  'linkedin_accounts:update',
  'linkedin_accounts:delete',
  'linkedin_ideas:view',
  'linkedin_ideas:create',
  'linkedin_ideas:update',
  'linkedin_ideas:delete',
  'linkedin_posts:view',
  'linkedin_posts:create',
  'linkedin_posts:update',
  'linkedin_posts:delete',

  // Credentials vault — operational access, no hard delete, no
  // settings. `credential_audit:view` is included so Admin Manager
  // can review Sensitive Access history.
  'credentials:view',
  'credentials:create',
  'credentials:update',
  'credentials:archive',
  'credentials:reveal',
  'credentials:attachments',
  'credential_audit:view',

  // Phone Numbers — full operational access, including maintenance.
  'phone_numbers:view',
  'phone_numbers:create',
  'phone_numbers:update',
  'phone_numbers:delete',
  'phone_numbers:maintain',

  // Portfolio — full access including PDF export.
  'portfolio:view',
  'portfolio:create',
  'portfolio:update',
  'portfolio:delete',
  'portfolio:export',

  // Workspace notifications / attention feed. Admin Manager runs
  // day-to-day ops and still needs the Notification Bell + pages so
  // scanner outages, business signals and admin events reach them.
  'notifications:view',

  // Deliberately NOT granted (Owner-only). Keep this list exhaustive:
  // every row here is a decision, not an oversight.
  //   • settings:view, settings:update, settings_scanner:update,
  //     settings_invoicing:update — the ENTIRE Settings surface is
  //     hidden from Admin Manager (nav + direct URL + API 403).
  //   • finances_weekly:*, finances:*, cashflow:view, profit:view
  //   • salaries:*, including salaries:reopen (Paid-run reopen is a
  //     deliberate escape hatch gated to Owner by seed assignment).
  //   • salaries:*, compensation_reviews:*, compensation_analytics:view
  //   • payment_sources:*
  //   • contractor_scope:view / contractor_scope:manage
  //   • roles:*
  //   • backups:*
  //   • credentials:hard_delete
  //   • employees:create / update / delete
]);

/**
 * Regular Manager — strict read-only on projects + reports. The
 * service layer additionally scopes reads to the caller's own
 * Employee.userId when `projects:view_any` is absent (which it is
 * here). Everything else is deny by default; the Owner may grant
 * more capabilities via the Roles UI by cloning this role into a
 * custom one.
 */
export const REGULAR_MANAGER_PRESET_KEYS: ReadonlySet<string> = new Set<string>([
  'projects:view',
  'project_reports:view',
]);

/**
 * The three canonical system role names. The seed owns their
 * lifecycle; nothing else should match on these literals when
 * writing custom-role logic.
 */
export const SYSTEM_ROLE_NAMES = ['owner', 'admin_manager', 'regular_manager'] as const;
export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];
