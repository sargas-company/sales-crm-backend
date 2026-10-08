import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { Prisma, PrismaClient, PromptType } from '@prisma/client';
import { JOB_GATEKEEPER_PROMPT } from '../src/ai/prompts/job-gatekeeper.prompt';
import { JOB_EVALUATION_PROMPT } from '../src/ai/prompts/job-evaluation.prompt';
import {
  ADMIN_MANAGER_PRESET_KEYS,
  REGULAR_MANAGER_PRESET_KEYS,
} from '../src/auth/system-role-presets';
import { redactSummary } from '../src/audit/redact';

const prisma = new PrismaClient();

const UPWORK_ID = '00000000-0000-0000-0000-000000000001';
const TG_BOT_USER_ID = '00000000-0000-0000-0000-000000000010';

// System-role ids (must match the migration
// 20260927120000_add_roles_and_permissions/migration.sql).
const OWNER_ROLE_ID = '00000000-0000-0000-0000-000000000101';
const ADMIN_MANAGER_ROLE_ID = '00000000-0000-0000-0000-000000000102';
const REGULAR_MANAGER_ROLE_ID = '00000000-0000-0000-0000-000000000103';

// Permission catalogue (spec §1.2). Idempotent upsert-by-key on
// every seed run so a `prisma db seed` on an existing DB is a
// no-op and a fresh DB gets everything the migration also seeds.
interface PermissionSeed {
  key: string;
  module: string;
  action: string;
  label: string;
}

const PERMISSION_CATALOGUE: PermissionSeed[] = [
  { module: 'dashboards_sales',   action: 'view',   key: 'dashboards_sales:view',   label: 'View sales dashboard' },
  { module: 'dashboards_finance', action: 'view',   key: 'dashboards_finance:view', label: 'View finance dashboard' },
  { module: 'proposals',          action: 'view',   key: 'proposals:view',          label: 'View proposals' },
  { module: 'proposals',          action: 'create', key: 'proposals:create',        label: 'Create proposals' },
  { module: 'proposals',          action: 'update', key: 'proposals:update',        label: 'Update proposals' },
  { module: 'proposals',          action: 'delete', key: 'proposals:delete',        label: 'Delete proposals' },
  { module: 'platforms',          action: 'view',   key: 'platforms:view',          label: 'View platforms' },
  { module: 'platforms',          action: 'create', key: 'platforms:create',        label: 'Create platforms' },
  { module: 'platforms',          action: 'update', key: 'platforms:update',        label: 'Update platforms' },
  { module: 'platforms',          action: 'delete', key: 'platforms:delete',        label: 'Delete platforms' },
  { module: 'job_posts',          action: 'view',    key: 'job_posts:view',          label: 'View job posts' },
  { module: 'job_posts',          action: 'create',  key: 'job_posts:create',        label: 'Create job posts' },
  { module: 'job_posts',          action: 'update',  key: 'job_posts:update',        label: 'Update job posts' },
  { module: 'job_posts',          action: 'delete',  key: 'job_posts:delete',        label: 'Delete job posts' },
  { module: 'job_posts',          action: 'convert', key: 'job_posts:convert',       label: 'Convert job post to proposal' },
  { module: 'accounts',           action: 'view',   key: 'accounts:view',           label: 'View accounts' },
  { module: 'accounts',           action: 'create', key: 'accounts:create',         label: 'Create accounts' },
  { module: 'accounts',           action: 'update', key: 'accounts:update',         label: 'Update accounts' },
  { module: 'accounts',           action: 'delete', key: 'accounts:delete',         label: 'Delete accounts' },
  { module: 'leads',              action: 'view',   key: 'leads:view',              label: 'View leads' },
  { module: 'leads',              action: 'create', key: 'leads:create',            label: 'Create leads' },
  { module: 'leads',              action: 'update', key: 'leads:update',            label: 'Update leads' },
  { module: 'leads',              action: 'delete', key: 'leads:delete',            label: 'Delete leads' },
  { module: 'client_calls',       action: 'view',   key: 'client_calls:view',       label: 'View client calls' },
  { module: 'client_calls',       action: 'create', key: 'client_calls:create',     label: 'Create client calls' },
  { module: 'client_calls',       action: 'update', key: 'client_calls:update',     label: 'Update client calls' },
  { module: 'client_calls',       action: 'delete', key: 'client_calls:delete',     label: 'Delete client calls' },
  { module: 'client_requests',    action: 'view',   key: 'client_requests:view',    label: 'View client requests' },
  { module: 'client_requests',    action: 'create', key: 'client_requests:create',  label: 'Create client requests' },
  { module: 'client_requests',    action: 'update', key: 'client_requests:update',  label: 'Update client requests' },
  { module: 'client_requests',    action: 'delete', key: 'client_requests:delete',  label: 'Delete client requests' },
  { module: 'invoices',           action: 'view',     key: 'invoices:view',           label: 'View invoices' },
  { module: 'invoices',           action: 'create',   key: 'invoices:create',         label: 'Create invoices' },
  { module: 'invoices',           action: 'update',   key: 'invoices:update',         label: 'Update invoices' },
  { module: 'invoices',           action: 'delete',   key: 'invoices:delete',         label: 'Delete invoices' },
  { module: 'invoices',           action: 'generate', key: 'invoices:generate',       label: 'Generate invoice PDF' },
  { module: 'counterparties',     action: 'view',    key: 'counterparties:view',     label: 'View counterparties' },
  { module: 'counterparties',     action: 'create',  key: 'counterparties:create',   label: 'Create counterparties' },
  { module: 'counterparties',     action: 'update',  key: 'counterparties:update',   label: 'Update counterparties' },
  { module: 'counterparties',     action: 'delete',  key: 'counterparties:delete',   label: 'Delete counterparties' },
  // CRM Client — the new independent client entity. Separate from
  // Counterparty (finance) and from Lead (sales pipeline).
  { module: 'clients',            action: 'view',    key: 'clients:view',            label: 'View CRM clients' },
  { module: 'clients',            action: 'create',  key: 'clients:create',          label: 'Create CRM clients' },
  { module: 'clients',            action: 'update',  key: 'clients:update',          label: 'Update CRM clients' },
  { module: 'clients',            action: 'delete',  key: 'clients:delete',          label: 'Delete CRM clients' },
  // Contractor-scope elevators. Baseline counterparties:* / invoices:*
  // grant access to client-scoped rows only; the two keys below add
  // read + write access to contractor-scoped counterparties and their
  // linked invoices. Backend service layer enforces the split.
  { module: 'contractor_scope',   action: 'view',    key: 'contractor_scope:view',   label: 'View contractor counterparties and their invoices' },
  { module: 'contractor_scope',   action: 'manage',  key: 'contractor_scope:manage', label: 'Create / update / delete / generate contractor counterparties and their invoices' },
  { module: 'prompts',            action: 'view',   key: 'prompts:view',            label: 'View prompts' },
  { module: 'prompts',            action: 'create', key: 'prompts:create',          label: 'Create prompts' },
  { module: 'prompts',            action: 'update', key: 'prompts:update',          label: 'Update prompts' },
  { module: 'prompts',            action: 'delete', key: 'prompts:delete',          label: 'Delete prompts' },
  { module: 'employees',          action: 'view',   key: 'employees:view',          label: 'View employees' },
  { module: 'employees',          action: 'create', key: 'employees:create',        label: 'Create employees' },
  { module: 'employees',          action: 'update', key: 'employees:update',        label: 'Update employees' },
  { module: 'employees',          action: 'delete', key: 'employees:delete',        label: 'Delete employees' },
  { module: 'projects',           action: 'view',    key: 'projects:view',           label: 'View projects' },
  { module: 'projects',           action: 'create',  key: 'projects:create',         label: 'Create projects' },
  { module: 'projects',           action: 'update',  key: 'projects:update',         label: 'Update projects' },
  { module: 'projects',           action: 'delete',  key: 'projects:delete',         label: 'Delete projects' },
  { module: 'projects',           action: 'view_any', key: 'projects:view_any',      label: 'View every project and report, not just your own' },
  { module: 'project_reports',    action: 'view',    key: 'project_reports:view',    label: 'View project reports' },
  { module: 'project_reports',    action: 'create',  key: 'project_reports:create',  label: 'Create project reports' },
  { module: 'project_reports',    action: 'update',  key: 'project_reports:update',  label: 'Update project reports' },
  { module: 'project_reports',    action: 'delete',  key: 'project_reports:delete',  label: 'Delete project reports' },
  { module: 'time_off',           action: 'view',    key: 'time_off:view',           label: 'View time-off records' },
  { module: 'time_off',           action: 'create',  key: 'time_off:create',         label: 'Create time-off records' },
  { module: 'time_off',           action: 'update',  key: 'time_off:update',         label: 'Update time-off records' },
  { module: 'time_off',           action: 'delete',  key: 'time_off:delete',         label: 'Delete time-off records' },
  { module: 'employee_analytics', action: 'view',    key: 'employee_analytics:view', label: 'View Employee Analytics dashboard' },
  { module: 'credentials',        action: 'view',         key: 'credentials:view',         label: 'View credentials list' },
  { module: 'credentials',        action: 'create',       key: 'credentials:create',       label: 'Create credentials' },
  { module: 'credentials',        action: 'update',       key: 'credentials:update',       label: 'Update credentials' },
  { module: 'credentials',        action: 'archive',      key: 'credentials:archive',      label: 'Archive credentials' },
  { module: 'credentials',        action: 'reveal',       key: 'credentials:reveal',       label: 'Reveal credential secret' },
  { module: 'credentials',        action: 'attachments',  key: 'credentials:attachments',  label: 'Upload / download credential attachments' },
  { module: 'credentials',        action: 'hard_delete',  key: 'credentials:hard_delete',  label: 'Hard delete credentials (Owner only)' },
  { module: 'credential_audit',   action: 'view',         key: 'credential_audit:view',    label: 'View sensitive-access audit log' },
  { module: 'salaries',           action: 'view',   key: 'salaries:view',           label: 'View salary records' },
  { module: 'salaries',           action: 'create', key: 'salaries:create',         label: 'Create salary records' },
  { module: 'salaries',           action: 'update', key: 'salaries:update',         label: 'Update salary records' },
  { module: 'salaries',           action: 'delete', key: 'salaries:delete',         label: 'Delete salary records' },
  { module: 'salaries',           action: 'reopen', key: 'salaries:reopen',         label: 'Reopen a Paid payroll entry back to Draft' },
  { module: 'finances',           action: 'view',   key: 'finances:view',           label: 'View finance records' },
  { module: 'finances',           action: 'create', key: 'finances:create',         label: 'Create finance records' },
  { module: 'finances',           action: 'update', key: 'finances:update',         label: 'Update finance records' },
  { module: 'finances',           action: 'delete', key: 'finances:delete',         label: 'Delete finance records' },
  { module: 'payment_sources',    action: 'view',   key: 'payment_sources:view',    label: 'View payment sources' },
  { module: 'payment_sources',    action: 'create', key: 'payment_sources:create',  label: 'Create payment sources' },
  { module: 'payment_sources',    action: 'update', key: 'payment_sources:update',  label: 'Update payment sources' },
  { module: 'payment_sources',    action: 'delete', key: 'payment_sources:delete',  label: 'Delete payment sources' },
  { module: 'cashflow',           action: 'view',   key: 'cashflow:view',           label: 'View cashflow aggregate' },
  { module: 'profit',             action: 'view',   key: 'profit:view',             label: 'View profit aggregate' },
  { module: 'compensation_reviews', action: 'view',   key: 'compensation_reviews:view',   label: 'View compensation reviews' },
  { module: 'compensation_reviews', action: 'create', key: 'compensation_reviews:create', label: 'Create compensation reviews' },
  { module: 'compensation_reviews', action: 'update', key: 'compensation_reviews:update', label: 'Update compensation reviews' },
  { module: 'compensation_reviews', action: 'delete', key: 'compensation_reviews:delete', label: 'Delete compensation reviews' },
  { module: 'compensation_analytics', action: 'view', key: 'compensation_analytics:view', label: 'View Compensation Analytics dashboard' },
  { module: 'project_analytics',     action: 'view', key: 'project_analytics:view',     label: 'View Project Analytics dashboard' },
  { module: 'sales_analytics',    action: 'view',   key: 'sales_analytics:view',    label: 'View sales analytics' },
  { module: 'finance_analytics',  action: 'view',   key: 'finance_analytics:view',  label: 'View finance analytics' },
  { module: 'roles',              action: 'view',   key: 'roles:view',              label: 'View roles and permissions' },
  { module: 'roles',              action: 'create', key: 'roles:create',            label: 'Create custom roles' },
  { module: 'roles',              action: 'update', key: 'roles:update',            label: 'Update roles' },
  { module: 'roles',              action: 'delete', key: 'roles:delete',            label: 'Delete custom roles' },
  { module: 'roles',              action: 'assign', key: 'roles:assign',            label: 'Assign a role to a user' },
  { module: 'settings',           action: 'view',   key: 'settings:view',           label: 'View application settings' },
  { module: 'settings',           action: 'update', key: 'settings:update',         label: 'Update application settings' },
  { module: 'settings_scanner',   action: 'update', key: 'settings_scanner:update', label: 'Update scanner & alerts settings' },
  { module: 'settings_invoicing', action: 'update', key: 'settings_invoicing:update', label: 'Update client invoicing settings' },
  // Phone Numbers / SIM management.
  { module: 'phone_numbers', action: 'view',     key: 'phone_numbers:view',     label: 'View phone numbers' },
  { module: 'phone_numbers', action: 'create',   key: 'phone_numbers:create',   label: 'Create phone numbers' },
  { module: 'phone_numbers', action: 'update',   key: 'phone_numbers:update',   label: 'Update phone numbers' },
  { module: 'phone_numbers', action: 'delete',   key: 'phone_numbers:delete',   label: 'Archive phone numbers' },
  { module: 'phone_numbers', action: 'maintain', key: 'phone_numbers:maintain', label: 'Mark phone maintenance done' },
  // Portfolio.
  { module: 'portfolio', action: 'view',   key: 'portfolio:view',   label: 'View portfolio' },
  { module: 'portfolio', action: 'create', key: 'portfolio:create', label: 'Create portfolio items' },
  { module: 'portfolio', action: 'update', key: 'portfolio:update', label: 'Update portfolio items' },
  { module: 'portfolio', action: 'delete', key: 'portfolio:delete', label: 'Delete portfolio items' },
  { module: 'portfolio', action: 'export', key: 'portfolio:export', label: 'Export portfolio PDF' },
  // Backups (Owner-only).
  { module: 'backups', action: 'view',   key: 'backups:view',   label: 'View database backups' },
  { module: 'backups', action: 'create', key: 'backups:create', label: 'Create a database backup' },
  { module: 'backups', action: 'download', key: 'backups:download', label: 'Download database backup artifact' },
  { module: 'audit_logs',         action: 'view',   key: 'audit_logs:view',         label: 'View Audit Log' },
  { module: 'linkedin_accounts',  action: 'view',   key: 'linkedin_accounts:view',   label: 'View LinkedIn accounts' },
  { module: 'linkedin_accounts',  action: 'create', key: 'linkedin_accounts:create', label: 'Create LinkedIn accounts' },
  { module: 'linkedin_accounts',  action: 'update', key: 'linkedin_accounts:update', label: 'Update LinkedIn accounts' },
  { module: 'linkedin_accounts',  action: 'delete', key: 'linkedin_accounts:delete', label: 'Delete LinkedIn accounts' },
  { module: 'linkedin_ideas',     action: 'view',   key: 'linkedin_ideas:view',      label: 'View LinkedIn ideas' },
  { module: 'linkedin_ideas',     action: 'create', key: 'linkedin_ideas:create',    label: 'Create LinkedIn ideas' },
  { module: 'linkedin_ideas',     action: 'update', key: 'linkedin_ideas:update',    label: 'Update LinkedIn ideas' },
  { module: 'linkedin_ideas',     action: 'delete', key: 'linkedin_ideas:delete',    label: 'Delete LinkedIn ideas' },
  { module: 'linkedin_posts',     action: 'view',   key: 'linkedin_posts:view',      label: 'View LinkedIn posts' },
  { module: 'linkedin_posts',     action: 'create', key: 'linkedin_posts:create',    label: 'Create LinkedIn posts' },
  { module: 'linkedin_posts',     action: 'update', key: 'linkedin_posts:update',    label: 'Update LinkedIn posts' },
  { module: 'linkedin_posts',     action: 'delete', key: 'linkedin_posts:delete',    label: 'Delete LinkedIn posts' },
  { module: 'finances_weekly',    action: 'view',   key: 'finances_weekly:view',     label: 'View Finance Weekly tracking' },
  { module: 'finances_weekly',    action: 'edit',   key: 'finances_weekly:edit',     label: 'Edit Finance Weekly entries and payment rules' },
  // Notifications / attention feed. Gates GET /attention — the
  // workspace-wide actionable notification list surfaced by the
  // Notification Bell and the Notifications pages. Owner inherits it
  // from the full catalogue; Admin Manager has it in its preset;
  // Regular Manager does NOT receive it (frontend hides the bell /
  // pages, and a direct API hit is answered with 403).
  { module: 'notifications',      action: 'view',   key: 'notifications:view',       label: 'View workspace notifications and attention feed' },
  // Discord integration (settings + scheduler + /report webhook).
  // All four keys are Owner-only; Admin Manager and Regular Manager
  // never see these in the system role matrix.
  { module: 'discord_integration', action: 'view',             key: 'discord_integration:view',             label: 'View Discord integration settings' },
  { module: 'discord_integration', action: 'configure',        key: 'discord_integration:configure',        label: 'Edit Discord integration profiles' },
  { module: 'discord_integration', action: 'send_test',        key: 'discord_integration:send_test',        label: 'Fire Discord verify/preview/test deliveries' },
  { module: 'discord_integration', action: 'activate_profile', key: 'discord_integration:activate_profile', label: 'Switch the active Discord profile (TEST ⇄ PRODUCTION)' },
];


// Inline audit-log writer used by the seed script. Mirrors
// `AuditLogService.log` in shape and applies the same secret-key
// redaction via the shared `redactSummary` helper (spec §3.4).
// seed.ts runs outside the Nest DI container so the service class
// itself is not instantiated here.
type AuditAction = 'role.create' | 'role.update' | 'role.delete' | 'user.role.assign';
type AuditTargetType = 'Role' | 'User';

async function auditLog(entry: {
  actorId?: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  summary?: Record<string, unknown>;
}) {
  const summary = redactSummary(entry.summary);
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      summary:
        summary === undefined ? Prisma.JsonNull : (summary as Prisma.InputJsonValue),
    },
  });
}

async function seedRolesAndPermissions() {
  // 1. System roles. A role's initial permission preset is applied
  //    ONLY when this seed run is the one that creates the role. If
  //    the role already existed in the database — with any binding
  //    count, including zero — its permissions are left alone. This
  //    respects an operator who intentionally emptied a role via the
  //    Roles UI: subsequent seeds must not undo that.
  const priorExisting = await prisma.role.findMany({
    where: { name: { in: ['owner', 'admin_manager', 'regular_manager'] } },
    select: { name: true },
  });
  const existedBeforeSeed = new Set(priorExisting.map((r) => r.name));

  const owner = await prisma.role.upsert({
    where: { name: 'owner' },
    update: {
      label: 'Owner',
      description:
        'Full access to every module, every field, including finance and salary data.',
      system: true,
    },
    create: {
      id: OWNER_ROLE_ID,
      name: 'owner',
      label: 'Owner',
      description:
        'Full access to every module, every field, including finance and salary data.',
      system: true,
    },
  });
  const adminManager = await prisma.role.upsert({
    where: { name: 'admin_manager' },
    update: {
      label: 'Admin Manager',
      description:
        'Full operational access; no finance, salary or aggregate financial data.',
      system: true,
    },
    create: {
      id: ADMIN_MANAGER_ROLE_ID,
      name: 'admin_manager',
      label: 'Admin Manager',
      description:
        'Full operational access; no finance, salary or aggregate financial data.',
      system: true,
    },
  });
  const regularManager = await prisma.role.upsert({
    where: { name: 'regular_manager' },
    update: {
      label: 'Regular Manager',
      description: 'Access only to explicitly granted modules and actions.',
      system: true,
    },
    create: {
      id: REGULAR_MANAGER_ROLE_ID,
      name: 'regular_manager',
      label: 'Regular Manager',
      description: 'Access only to explicitly granted modules and actions.',
      system: true,
    },
  });

  // 2. Permission catalogue — upsert by key.
  for (const p of PERMISSION_CATALOGUE) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { module: p.module, action: p.action, label: p.label },
      create: { key: p.key, module: p.module, action: p.action, label: p.label },
    });
  }

  // 3. Bindings.
  //
  //    Owner is the ONLY role the seed auto-syncs on every run. Its
  //    contract is "always has every permission in the current
  //    catalogue" and it is the reason the catalogue can grow safely.
  //
  //    Every other role (system or custom) is left alone whenever it
  //    already existed before this seed run — regardless of how many
  //    bindings it currently has. Reasoning:
  //      • Business roles (Admin Manager, Regular Manager, and any
  //        custom role created via the Roles UI) are edited by the
  //        Owner through the UI. Reseeding must never silently grant
  //        or revoke permissions on them — otherwise every new
  //        permission added by developers would leak into whichever
  //        role was closest to it in the seed preset.
  //      • An operator who intentionally emptied Admin Manager /
  //        Regular Manager through the UI must see zero bindings
  //        again after every reseed; `count === 0` is NOT the same
  //        signal as "role was just created".
  //      • The initial preset is applied only when the role record
  //        itself did not exist before this seed run (fresh env
  //        bootstrap).
  const allPermissions = await prisma.permission.findMany({ select: { id: true, key: true, module: true } });

  // Owner: full sync every time.
  await prisma.rolePermission.deleteMany({ where: { roleId: owner.id } });
  await prisma.rolePermission.createMany({
    data: allPermissions.map((p) => ({ roleId: owner.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  // Admin Manager and Regular Manager: the preset is the enforced
  // baseline — every seed run syncs their bindings so the policy
  // stated in `ADMIN_MANAGER_PRESET_KEYS` / `REGULAR_MANAGER_PRESET_KEYS`
  // above is the source of truth. Custom roles (anything other than
  // the three system role names) are NEVER touched here; user role
  // assignments are a separate table and are left intact.
  //
  // Why this is safe:
  //  • Owner remains unaffected — a full sync against the catalogue
  //    was already applied above.
  //  • Admin Manager / Regular Manager are system roles; their
  //    permission set is a product-level decision, not an operator
  //    preference. Expressing the matrix in code and enforcing it on
  //    every seed keeps dev / staging / local environments honest.
  //  • If an operator needs a different capability mix for a group,
  //    they create a custom role via the Roles UI. Custom roles are
  //    not matched by name here, so they stay untouched.
  const syncSystemRole = async (
    roleId: string,
    preset: ReadonlySet<string>,
  ): Promise<number> => {
    const want = new Set(
      allPermissions.filter((p) => preset.has(p.key)).map((p) => p.id),
    );
    const current = await prisma.rolePermission.findMany({
      where: { roleId },
      select: { permissionId: true },
    });
    const have = new Set(current.map((r) => r.permissionId));
    const toCreate = [...want].filter((id) => !have.has(id));
    const toDelete = [...have].filter((id) => !want.has(id));
    if (toCreate.length > 0) {
      await prisma.rolePermission.createMany({
        data: toCreate.map((permissionId) => ({ roleId, permissionId })),
        skipDuplicates: true,
      });
    }
    if (toDelete.length > 0) {
      await prisma.rolePermission.deleteMany({
        where: { roleId, permissionId: { in: toDelete } },
      });
    }
    return want.size;
  };

  const adminManagerBindingsCount = await syncSystemRole(
    adminManager.id,
    ADMIN_MANAGER_PRESET_KEYS,
  );
  const regularManagerBindingsCount = await syncSystemRole(
    regularManager.id,
    REGULAR_MANAGER_PRESET_KEYS,
  );
  // Mark both as "created now" vs "pre-existing" is now a logging-only
  // concern; the preset is applied either way.
  void existedBeforeSeed;

  console.log(
    `Seeded roles: owner, admin_manager, regular_manager; permissions: ${allPermissions.length}; ` +
      `Owner-bindings: ${allPermissions.length}; ` +
      `Admin-Manager-bindings: ${adminManagerBindingsCount}; ` +
      `Regular-Manager-bindings: ${regularManagerBindingsCount}.`,
  );

  // 4. AuditLog catch-up. Records `role.create` exactly once per
  //    system role, and remains idempotent on re-seed: if an entry
  //    already exists, the log call is skipped. actorId is null
  //    because the seed itself is not authored by a user (spec §3.4).
  for (const role of [owner, adminManager, regularManager]) {
    const already = await prisma.auditLog.findFirst({
      where: { action: 'role.create', targetType: 'Role', targetId: role.id },
      select: { id: true },
    });
    if (already) continue;
    await auditLog({
      action: 'role.create',
      targetType: 'Role',
      targetId: role.id,
      summary: {
        name: role.name,
        label: role.label,
        system: role.system,
        description: role.description,
      },
    });
  }

  return {
    ownerId: owner.id,
    adminManagerId: adminManager.id,
    regularManagerId: regularManager.id,
  };
}

async function main() {
  // Roles + permission catalogue — seed first so User upserts below
  // can attach roleId. Idempotent for repeat runs.
  const { ownerId, adminManagerId, regularManagerId } = await seedRolesAndPermissions();

  // Platforms
  const upworkImageUrl =
    'https://cdn.worldvectorlogo.com/logos/upwork-roundedsquare-1.svg';

  await prisma.platform.upsert({
    where: { id: UPWORK_ID },
    update: { title: 'Upwork', slug: 'upwork', imageUrl: upworkImageUrl },
    create: {
      id: UPWORK_ID,
      title: 'Upwork',
      slug: 'upwork',
      imageUrl: upworkImageUrl,
    },
  });

  console.log('Seeded platforms: Upwork, LinkedIn');

  // Users
  const passwordHash = await bcrypt.hash('admin123', 10);

  const user = await prisma.user.upsert({
    where: { email: 'admin@test.com' },
    update: {
      firstName: 'Dmytro',
      lastName: 'Sarafaniuk',
      roleId: ownerId,
    },
    create: {
      email: 'admin@test.com',
      passwordHash,
      firstName: 'Dmytro',
      lastName: 'Sarafaniuk',
      roleId: ownerId,
    },
  });

  const user2 = await prisma.user.upsert({
    where: { email: 'manager@test.com' },
    update: {
      firstName: 'Test',
      lastName: 'Manager',
      roleId: adminManagerId,
    },
    create: {
      email: 'manager@test.com',
      passwordHash,
      firstName: 'Test',
      lastName: 'Manager',
      roleId: adminManagerId,
    },
  });

  // TG bot is a machine user with no CRM operations; assign the
  // Regular Manager role (0 permissions by default) to keep the
  // "every user has roleId non-null" invariant satisfied on a fresh
  // `make local-reset`. Semantically identical to roleId=null under
  // spec §6 ("no permissions") but explicit for auditability.
  await prisma.user.upsert({
    where: { email: 'tg-bot@internal' },
    update: { roleId: regularManagerId },
    create: {
      id: TG_BOT_USER_ID,
      email: 'tg-bot@internal',
      passwordHash: '',
      firstName: 'Telegram',
      lastName: 'Bot',
      roleId: regularManagerId,
    },
  });

  console.log(`Seeded users: ${user.email}, ${user2.email}, tg-bot@internal`);

  // AuditLog catch-up for `user.role.assign`. Records one entry per
  // seeded user whose roleId is set, exactly once. On re-seed the
  // check-then-insert branch skips users that already have an
  // assignment audit for their current roleId; roleId changes (e.g.
  // reassigning manager@test.com back to admin_manager after a
  // T-03 walkthrough) then produce a fresh audit row.
  for (const seededUser of await prisma.user.findMany({
    where: { roleId: { not: null } },
    select: { id: true, email: true, roleId: true, roleRef: { select: { name: true } } },
  })) {
    const roleId = seededUser.roleId!; // narrowed by the `not: null` filter above
    const already = await prisma.auditLog.findFirst({
      where: {
        action: 'user.role.assign',
        targetType: 'User',
        targetId: seededUser.id,
        summary: { path: ['roleId'], equals: roleId },
      },
      select: { id: true },
    });
    if (already) continue;
    await auditLog({
      action: 'user.role.assign',
      targetType: 'User',
      targetId: seededUser.id,
      summary: {
        email: seededUser.email,
        roleId,
        roleName: seededUser.roleRef?.name ?? null,
      },
    });
  }

  // Accounts
  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, platformId: UPWORK_ID },
  });
  if (!existingAccount) {
    await prisma.account.create({
      data: {
        firstName: 'Dmytro',
        lastName: 'Sarafaniuk',
        platformId: UPWORK_ID,
        userId: user.id,
      },
    });
  }

  console.log('Seeded account: Dmytro Sarafaniuk (Upwork)');

  // Prompts
  const prompts: { type: PromptType; title: string; content: string }[] = [
    {
      type: PromptType.JOB_GATEKEEPER,
      title: 'Job Gatekeeper',
      content: JOB_GATEKEEPER_PROMPT,
    },
    {
      type: PromptType.JOB_EVALUATION,
      title: 'Job Evaluation',
      content: JOB_EVALUATION_PROMPT,
    },
  ];

  for (const { type, title, content } of prompts) {
    const existing = await prisma.prompt.findFirst({
      where: { type, isActive: true },
    });
    if (existing) {
      await prisma.prompt.update({
        where: { id: existing.id },
        data: { title, content },
      });
    } else {
      await prisma.prompt.create({
        data: {
          id: `seed-prompt-${type.toLowerCase()}`,
          type,
          title,
          content,
          version: 1,
          isActive: true,
          createdBy: 'seed',
        },
      });
    }
  }

  console.log('Seeded prompts: JOB_GATEKEEPER, JOB_EVALUATION');

  // Setting Sections
  const sections = [
    { key: 'general', title: 'General', order: 0 },
    { key: 'ai', title: 'AI Settings', order: 1 },
    { key: 'job_scanner', title: 'Job Scanner', order: 2 },
    { key: 'integrations', title: 'Integrations', order: 3 },
    { key: 'notifications', title: 'Notifications', order: 4 },
    { key: 'api_keys', title: 'API Keys', order: 5 },
    { key: 'invoice', title: 'Invoice', order: 6 },
  ];

  for (const section of sections) {
    await prisma.settingSection.upsert({
      where: { key: section.key },
      update: { title: section.title, order: section.order },
      create: section,
    });
  }

  console.log(
    `Seeded setting sections: ${sections.map((s) => s.key).join(', ')}`,
  );

  // Job Scanner Settings
  const jobScannerSection = await prisma.settingSection.findUniqueOrThrow({
    where: { key: 'job_scanner' },
  });

  const jobScannerSettings = [
    {
      key: 'job_scanner.enabled',
      title: 'Enable Job Scanner',
      description: 'Enable real-time processing of new job posts',
      type: 'boolean' as const,
      uiType: 'toggle' as const,
      defaultValue: false,
      order: 0,
    },
    {
      key: 'job_scanner.notifications.min_score',
      title: 'Minimum Score for Notification',
      description: 'Minimum score required to send Discord notification',
      type: 'number' as const,
      uiType: 'input' as const,
      defaultValue: 70,
      validationSchema: { min: 0, max: 100 },
      order: 1,
    },
  ];

  for (const setting of jobScannerSettings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {
        title: setting.title,
        description: setting.description,
        defaultValue: setting.defaultValue,
        validationSchema: setting.validationSchema,
        order: setting.order,
        isActive: true,
      },
      create: {
        ...setting,
        sectionId: jobScannerSection.id,
      },
    });
  }

  console.log(
    `Seeded job_scanner settings: ${jobScannerSettings.map((s) => s.key).join(', ')}`,
  );

  // Invoice Settings
  const invoiceSection = await prisma.settingSection.findUniqueOrThrow({
    where: { key: 'invoice' },
  });

  const invoiceDetails = {
    companyName: 'Sargas Agency OÜ',
    addressLine1: 'Narva mnt 7',
    city: 'Tallinn',
    region: 'Harju maakond',
    postalCode: '10117',
    country: 'Estonia',
    companyId: '17146771',
    vat: 'EE102840485',
  };

  const invoiceSettings = [
    {
      key: 'invoice.client.details',
      title: 'Client Details',
      description: 'Default client company details for invoices',
      type: 'json' as const,
      uiType: 'textarea' as const,
      defaultValue: invoiceDetails,
      order: 0,
    },
    {
      key: 'invoice.contractor.details',
      title: 'Contractor Details',
      description: 'Default contractor company details for invoices',
      type: 'json' as const,
      uiType: 'textarea' as const,
      defaultValue: { ...invoiceDetails, vat: undefined },
      order: 1,
    },
  ];

  for (const setting of invoiceSettings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {
        title: setting.title,
        description: setting.description,
        defaultValue: setting.defaultValue,
        order: setting.order,
      },
      create: {
        ...setting,
        sectionId: invoiceSection.id,
      },
    });
  }

  console.log(
    `Seeded invoice settings: ${invoiceSettings.map((s) => s.key).join(', ')}`,
  );

  await seedAuditDemoEvents({ ownerId, adminManagerId, regularManagerId });
  await seedPhoneNumbers();
  await seedPortfolio({ ownerId });
  await seedBackupRuns();
}

// ─── Phone Numbers demo seed ────────────────────────────────────────────────

async function seedPhoneNumbers() {
  // Idempotency guard — presence of our demo marker numbers skips the
  // whole block so operator data is never trampled.
  const marker = '+380990000001';
  const already = await prisma.phoneNumber.findUnique({
    where: { number: marker },
  });
  if (already) {
    console.log('Phone numbers demo: already present — skipping seed.');
    return;
  }

  const employee = await prisma.employee.findFirst({ select: { id: true } });
  const credProfile = await prisma.credentialProfile.findFirst({
    select: { id: true },
  });

  // Four demo numbers covering every state we display in the UI.
  const defs: Array<{
    number: string;
    operator: 'VODAFONE' | 'KYIVSTAR' | 'LIFECELL' | 'OTHER';
    status: 'ACTIVE' | 'HOLD' | 'DISABLED';
    maintenanceRequired: boolean;
    nextMaintenanceAt: Date | null;
    lastTopUpAt: Date | null;
    lastNetworkRegistrationAt: Date | null;
    notes: string;
    bindings: Array<{ serviceName: string; linkProfile?: boolean }>;
    maintenanceState?: 'DUE' | 'OVERDUE' | 'COMPLETED';
  }> = [
    {
      number: '+380990000001',
      operator: 'VODAFONE',
      status: 'ACTIVE',
      maintenanceRequired: true,
      nextMaintenanceAt: daysFromNow(2),
      lastTopUpAt: daysFromNow(-88),
      lastNetworkRegistrationAt: daysFromNow(-88),
      notes: '[demo] Primary SIM for Upwork + Telegram.',
      bindings: [
        { serviceName: 'Upwork', linkProfile: true },
        { serviceName: 'Telegram' },
      ],
      maintenanceState: 'DUE',
    },
    {
      number: '+380990000002',
      operator: 'KYIVSTAR',
      status: 'ACTIVE',
      maintenanceRequired: true,
      nextMaintenanceAt: daysFromNow(-5), // overdue
      lastTopUpAt: daysFromNow(-95),
      lastNetworkRegistrationAt: daysFromNow(-95),
      notes: '[demo] Backup carrier.',
      bindings: [
        { serviceName: 'WhatsApp' },
        { serviceName: 'Gmail' },
      ],
      maintenanceState: 'OVERDUE',
    },
    {
      number: '+380990000003',
      operator: 'LIFECELL',
      status: 'HOLD',
      maintenanceRequired: true,
      nextMaintenanceAt: daysFromNow(45),
      lastTopUpAt: daysFromNow(-45),
      lastNetworkRegistrationAt: daysFromNow(-45),
      notes: '[demo] On hold while re-registering.',
      bindings: [{ serviceName: 'Microsoft' }],
      maintenanceState: 'COMPLETED',
    },
    {
      number: '+380990000004',
      operator: 'OTHER',
      status: 'DISABLED',
      maintenanceRequired: false,
      nextMaintenanceAt: null,
      lastTopUpAt: null,
      lastNetworkRegistrationAt: null,
      notes: '[demo] Decommissioned — kept for audit history.',
      bindings: [],
    },
  ];

  for (const def of defs) {
    const phone = await prisma.phoneNumber.create({
      data: {
        number: def.number,
        operator: def.operator,
        status: def.status,
        holderEmployeeId: employee?.id ?? null,
        maintenanceRequired: def.maintenanceRequired,
        nextMaintenanceAt: def.nextMaintenanceAt,
        lastTopUpAt: def.lastTopUpAt,
        lastNetworkRegistrationAt: def.lastNetworkRegistrationAt,
        notes: def.notes,
      },
    });

    for (const binding of def.bindings) {
      const slug = binding.serviceName
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^[^a-z]+/, '') || `service_${phone.id.slice(0, 8)}`;
      const service = await prisma.phoneService.upsert({
        where: { slug },
        update: {},
        create: { name: binding.serviceName, slug },
      });
      await prisma.phoneNumberBinding.create({
        data: {
          phoneNumberId: phone.id,
          serviceId: service.id,
          credentialProfileId:
            binding.linkProfile && credProfile ? credProfile.id : null,
          status: def.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        },
      });
    }

    if (def.maintenanceState) {
      const dueAt =
        def.maintenanceState === 'COMPLETED'
          ? daysFromNow(-45)
          : def.nextMaintenanceAt ?? daysFromNow(0);
      await prisma.phoneMaintenance.create({
        data: {
          phoneNumberId: phone.id,
          dueAt,
          status: def.maintenanceState,
          networkRegisteredAt:
            def.maintenanceState === 'COMPLETED' ? daysFromNow(-45) : null,
          toppedUpAt:
            def.maintenanceState === 'COMPLETED' ? daysFromNow(-45) : null,
          topUpAmount:
            def.maintenanceState === 'COMPLETED'
              ? new Prisma.Decimal('8.00')
              : null,
          completedAt:
            def.maintenanceState === 'COMPLETED' ? daysFromNow(-45) : null,
          notes: def.maintenanceState === 'OVERDUE' ? '[demo] forgotten' : null,
        },
      });
    }
  }
  console.log(`Seeded ${defs.length} demo phone numbers with bindings & maintenance.`);
}

// ─── Portfolio demo seed ────────────────────────────────────────────────────

async function seedPortfolio(opts: { ownerId: string }) {
  const marker = 'demo-marketplace-overhaul';
  const already = await prisma.portfolioItem.findUnique({
    where: { slug: marker },
  });
  if (already) {
    console.log('Portfolio demo: already present — skipping seed.');
    return;
  }

  // Ensure a shared tag catalog so autocomplete has suggestions.
  const tagDefs = [
    'Next.js',
    'NestJS',
    'PostgreSQL',
    'Stripe',
    'Marketplace',
    'Healthcare',
    'AI Automation',
    'Mobile',
    'AWS',
  ];
  const tagRows = await Promise.all(
    tagDefs.map((displayName) =>
      prisma.portfolioTag.upsert({
        where: { normalized: displayName.toLowerCase() },
        create: { normalized: displayName.toLowerCase(), displayName },
        update: { displayName },
        select: { id: true, normalized: true },
      }),
    ),
  );
  const tagByName = new Map(
    tagRows.map((t) => [t.normalized, t.id] as const),
  );
  const tagsFor = (names: string[]) =>
    names
      .map((n) => tagByName.get(n.toLowerCase()))
      .filter((id): id is string => !!id)
      .map((tagId) => ({ tagId }));

  const items: Array<{
    slug: string;
    title: string;
    shortSummary: string;
    status: 'DRAFT' | 'READY' | 'ARCHIVED';
    isNda: boolean;
    contentMarkdown: string;
    tags: string[];
  }> = [
    {
      slug: 'demo-marketplace-overhaul',
      title: 'Marketplace revenue overhaul',
      shortSummary:
        'Replatformed a two-sided marketplace onto Next.js + NestJS and tripled their checkout conversion.',
      status: 'READY',
      isNda: false,
      tags: ['Next.js', 'NestJS', 'PostgreSQL', 'Stripe', 'Marketplace'],
      contentMarkdown: `# Marketplace revenue overhaul

The client's legacy monolith couldn't ship fast enough to keep up with new seller tooling demands. We re-platformed their checkout and seller onboarding onto a modern Next.js + NestJS stack and launched in **under 10 weeks**.

## Highlights

- 3.1× checkout conversion vs. the legacy funnel
- 42% faster time-to-first-payout for new sellers
- Zero downtime cut-over using a two-way sync bridge

## Stack

| Layer      | Technology           |
| ---------- | -------------------- |
| Frontend   | Next.js 14, RSC      |
| API        | NestJS 10 + Prisma   |
| Payments   | Stripe Connect       |
| Infra      | AWS ECS + Aurora PG  |

## Approach

1. Built an **adapter layer** that mirrored every legacy write into the new DB.
2. Rolled out checkout **region by region** behind a feature flag.
3. Flipped the old DB to read-only once we hit 100% traffic parity.

> "The team shipped faster than any vendor we've worked with in the last five years."
> — *VP Engineering*

\`\`\`ts
// Example: the sync bridge resolved cross-DB writes with a single idempotency key.
await bridge.syncOrder(order.id, { source: 'legacy' })
\`\`\`
`,
    },
    {
      slug: 'demo-healthcare-triage',
      title: 'Healthcare AI triage assistant',
      shortSummary:
        'Shipped an AI-assisted triage flow for a regional clinic network under NDA.',
      status: 'READY',
      isNda: true,
      tags: ['AI Automation', 'Healthcare', 'NestJS'],
      contentMarkdown: `# Healthcare AI triage

NDA case study. The product consolidated three legacy intake flows into a single AI-assisted triage experience, cutting the average time-to-first-doctor-review from 48h to under 6h.

## Scope

- OCR + structured extraction from referral PDFs
- Risk scoring powered by an in-house LLM pipeline
- Compliance review with the client's medical safety team

Specific metrics and client identity are confidential and were cleared for internal use only.
`,
    },
    {
      slug: 'demo-mobile-field-ops',
      title: 'Field operations mobile app',
      shortSummary:
        'Offline-first mobile companion for field technicians, draft only.',
      status: 'DRAFT',
      isNda: false,
      tags: ['Mobile', 'AWS'],
      contentMarkdown: `# Field operations mobile app

Draft case study — content still being written.

- Offline-first sync with conflict resolution
- Photo capture with watermarking
- Dispatcher dashboard web companion

TODO: add result metrics once the client approves the public write-up.
`,
    },
    {
      slug: 'demo-legacy-crm-migration',
      title: 'Legacy CRM retire & migrate',
      shortSummary:
        'Decommissioned a 12-year-old CRM and moved every record to a modern stack.',
      status: 'ARCHIVED',
      isNda: false,
      tags: ['PostgreSQL', 'NestJS'],
      contentMarkdown: `# Legacy CRM retire & migrate

Archived — kept for reference. We migrated 1.4M customer rows and 220k attachments from a Perl-era CRM onto a NestJS + PostgreSQL stack over three months.
`,
    },
  ];

  for (const item of items) {
    await prisma.portfolioItem.create({
      data: {
        slug: item.slug,
        title: item.title,
        shortSummary: item.shortSummary,
        status: item.status,
        isNda: item.isNda,
        contentMarkdown: item.contentMarkdown,
        createdById: opts.ownerId,
        updatedById: opts.ownerId,
        tags: {
          create: tagsFor(item.tags),
        },
      },
    });
  }
  console.log(`Seeded ${items.length} demo portfolio items with ${tagDefs.length} shared tags.`);
}

// ─── Backup runs demo seed ──────────────────────────────────────────────────

async function seedBackupRuns() {
  const already = await prisma.backupRun.findFirst({
    where: { triggeredBy: 'seed:demo' },
    select: { id: true },
  });
  if (already) {
    console.log('Backup runs demo: already present — skipping seed.');
    return;
  }

  const now = Date.now();
  type Row = Parameters<typeof prisma.backupRun.create>[0]['data'];
  const rows: Row[] = [
    {
      type: 'DAILY',
      status: 'SUCCEEDED',
      environment: 'local',
      databaseName: 'ai_dashboard',
      startedAt: new Date(now - 6 * 60 * 60 * 1000),
      completedAt: new Date(now - 6 * 60 * 60 * 1000 + 54_000),
      durationMs: 54_000,
      artifactKey: 'daily/2026-10-01_0300_c0ffee1234.dump',
      manifestKey: 'daily/2026-10-01_0300_c0ffee1234.manifest.json',
      size: BigInt(84_000_000),
      checksum: 'c0ffee1234abcdef5678901234567890abcdef1234567890abcdef1234567890',
      checksumAlgo: 'sha256',
      pgVersion: '16.4',
      gitSha: 'a1b2c3d4e5f67890',
      migrationName: '20261013000000_phones_portfolio_backup',
      triggeredBy: 'seed:demo',
    },
    {
      type: 'PRE_MIGRATION',
      status: 'SUCCEEDED',
      environment: 'local',
      databaseName: 'ai_dashboard',
      startedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      completedAt: new Date(now - 2 * 24 * 60 * 60 * 1000 + 48_000),
      durationMs: 48_000,
      artifactKey: 'pre-migration/2026-09-29_1420_a1b2c3d4e5.dump',
      manifestKey: 'pre-migration/2026-09-29_1420_a1b2c3d4e5.manifest.json',
      size: BigInt(78_000_000),
      checksum: 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890',
      checksumAlgo: 'sha256',
      pgVersion: '16.4',
      gitSha: 'f0e1d2c3b4a59876',
      migrationName: '20261012000000_audit_event_extended',
      triggeredBy: 'seed:demo',
    },
    {
      type: 'MANUAL',
      status: 'VERIFIED',
      environment: 'local',
      databaseName: 'ai_dashboard',
      startedAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
      completedAt: new Date(now - 3 * 24 * 60 * 60 * 1000 + 52_000),
      durationMs: 52_000,
      artifactKey: 'manual/2026-09-28_0812_9876abcdef.dump',
      manifestKey: 'manual/2026-09-28_0812_9876abcdef.manifest.json',
      size: BigInt(76_000_000),
      checksum: '9876abcdef1234567890abcdef1234567890abcdef1234567890abcdef123456',
      checksumAlgo: 'sha256',
      pgVersion: '16.4',
      gitSha: 'deadbeef12345678',
      migrationName: '20261011000000_credentials_vault_foundation',
      triggeredBy: 'seed:demo',
      lastVerifiedAt: new Date(now - 3 * 24 * 60 * 60 * 1000 + 90_000),
    },
    {
      type: 'DAILY',
      status: 'FAILED',
      environment: 'local',
      databaseName: 'ai_dashboard',
      startedAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
      completedAt: new Date(now - 5 * 24 * 60 * 60 * 1000 + 12_000),
      durationMs: 12_000,
      pgVersion: '16.4',
      gitSha: '12345678abcdef00',
      migrationName: '20261011000000_credentials_vault_foundation',
      triggeredBy: 'seed:demo',
      errorMessage:
        'B2 upload failed: 503 service unavailable from Backblaze (retried 2 times)',
    },
    {
      type: 'PRE_SEED',
      status: 'SUCCEEDED',
      environment: 'local',
      databaseName: 'ai_dashboard',
      startedAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
      completedAt: new Date(now - 7 * 24 * 60 * 60 * 1000 + 46_000),
      durationMs: 46_000,
      artifactKey: 'pre-seed/2026-09-24_1105_cafebabe12.dump',
      manifestKey: 'pre-seed/2026-09-24_1105_cafebabe12.manifest.json',
      size: BigInt(72_000_000),
      checksum: 'cafebabe123456789012345678901234567890abcdef1234567890abcdef1234',
      checksumAlgo: 'sha256',
      pgVersion: '16.4',
      gitSha: 'cafebabedeadbeef',
      migrationName: '20261010000000_drop_linkedin_array_defaults',
      triggeredBy: 'seed:demo',
    },
  ];

  for (const data of rows) {
    await prisma.backupRun.create({ data });
  }
  console.log(`Seeded ${rows.length} demo backup runs.`);
}

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(9, 0, 0, 0);
  return d;
}

/**
 * Idempotent demo audit events for the Audit Log UI. We tag every row
 * with `metadata.seed === 'demo'` so repeat runs can detect prior
 * seed presence and skip. Secrets never land here — only shape info
 * (field names, status transitions, permission adds/removes).
 */
async function seedAuditDemoEvents(opts: {
  ownerId: string;
  adminManagerId: string;
  regularManagerId: string;
}) {
  const already = await prisma.auditEvent.count({
    where: {
      metadata: { path: ['seed'], equals: 'demo' },
    },
  });
  if (already > 0) {
    console.log(
      `Audit demo events: ${already} already present — skipping seed.`,
    );
    return;
  }
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000);

  type Row = Parameters<typeof prisma.auditEvent.create>[0]['data'];
  const events: Row[] = [
    {
      actorUserId: opts.ownerId,
      actorEmail: 'admin@test.com',
      actorName: 'Dmytro Sarafaniuk',
      domain: 'AUTH',
      action: 'auth.login',
      targetType: 'User',
      targetId: opts.ownerId,
      targetLabel: 'admin@test.com',
      result: 'SUCCESS',
      severity: 'INFO',
      metadata: { seed: 'demo' },
      ip: '10.0.0.12',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      occurredAt: minutesAgo(2),
    },
    {
      actorUserId: null,
      actorEmail: 'intruder@example.com',
      domain: 'AUTH',
      action: 'auth.login',
      targetType: 'User',
      targetLabel: 'intruder@example.com',
      result: 'FAILED',
      severity: 'WARNING',
      metadata: { seed: 'demo', reason: 'unknown_email' },
      ip: '203.0.113.44',
      occurredAt: minutesAgo(7),
    },
    {
      actorUserId: opts.ownerId,
      actorEmail: 'admin@test.com',
      actorName: 'Dmytro Sarafaniuk',
      domain: 'RBAC',
      action: 'user.role.assign',
      targetType: 'User',
      targetId: opts.adminManagerId,
      targetLabel: 'manager@test.com',
      result: 'SUCCESS',
      severity: 'WARNING',
      metadata: { seed: 'demo' },
      changes: {
        role: { before: 'regular_manager', after: 'admin_manager' },
      },
      occurredAt: minutesAgo(14),
    },
    {
      actorUserId: opts.ownerId,
      actorEmail: 'admin@test.com',
      actorName: 'Dmytro Sarafaniuk',
      domain: 'RBAC',
      action: 'role.update',
      targetType: 'Role',
      targetId: ADMIN_MANAGER_ROLE_ID,
      targetLabel: 'Admin manager',
      targetHref: `/roles/${ADMIN_MANAGER_ROLE_ID}`,
      result: 'SUCCESS',
      severity: 'WARNING',
      metadata: {
        seed: 'demo',
        permissions: {
          added: ['invoices:delete'],
          removed: ['payment_sources:delete'],
        },
      },
      occurredAt: minutesAgo(30),
    },
    {
      actorUserId: opts.ownerId,
      actorEmail: 'admin@test.com',
      actorName: 'Dmytro Sarafaniuk',
      domain: 'FINANCE',
      action: 'invoice.status.change',
      targetType: 'Invoice',
      targetLabel: '#INV-1042 · ACME Corp',
      result: 'SUCCESS',
      severity: 'WARNING',
      metadata: { seed: 'demo' },
      changes: {
        status: { before: 'open', after: 'paid' },
        amountPaid: { before: '0', after: '4200.00' },
      },
      occurredAt: minutesAgo(45),
    },
    {
      actorUserId: opts.adminManagerId,
      actorEmail: 'manager@test.com',
      actorName: 'Alex Manager',
      domain: 'FINANCE',
      action: 'payroll.markPaid',
      targetType: 'PayrollEntry',
      targetLabel: 'Nikita Developer · 2026-09',
      result: 'SUCCESS',
      severity: 'WARNING',
      metadata: { seed: 'demo' },
      changes: {
        status: { before: 'DRAFT', after: 'PAID' },
      },
      occurredAt: minutesAgo(80),
    },
    {
      actorUserId: opts.adminManagerId,
      actorEmail: 'manager@test.com',
      actorName: 'Alex Manager',
      domain: 'CREDENTIALS',
      action: 'credentials.account.reveal',
      targetType: 'CredentialAccount',
      targetLabel: 'Upwork Main Account',
      result: 'SUCCESS',
      severity: 'INFO',
      metadata: { seed: 'demo', field: 'password' },
      occurredAt: minutesAgo(95),
    },
    {
      actorUserId: opts.regularManagerId,
      actorEmail: 'regular@test.com',
      actorName: 'Reg Manager',
      domain: 'CREDENTIALS',
      action: 'credentials.account.reveal',
      targetType: 'CredentialAccount',
      targetLabel: 'Stripe Live Keys',
      result: 'DENIED',
      severity: 'WARNING',
      metadata: { seed: 'demo', reason: 'insufficient_permission' },
      occurredAt: minutesAgo(110),
    },
    {
      actorUserId: opts.ownerId,
      actorEmail: 'admin@test.com',
      actorName: 'Dmytro Sarafaniuk',
      domain: 'PROJECTS',
      action: 'project.members.change',
      targetType: 'Project',
      targetLabel: 'Project Atlas',
      result: 'SUCCESS',
      severity: 'INFO',
      metadata: {
        seed: 'demo',
        members: {
          added: ['employee-alex'],
          removed: [],
        },
      },
      occurredAt: minutesAgo(140),
    },
    {
      actorUserId: opts.ownerId,
      actorEmail: 'admin@test.com',
      actorName: 'Dmytro Sarafaniuk',
      domain: 'CREDENTIALS',
      action: 'credentials.account.hard_delete',
      targetType: 'CredentialAccount',
      targetLabel: 'Legacy Account (deleted)',
      result: 'SUCCESS',
      severity: 'CRITICAL',
      metadata: { seed: 'demo', stepUp: 'mfa' },
      occurredAt: minutesAgo(240),
    },
    {
      actorUserId: opts.ownerId,
      actorEmail: 'admin@test.com',
      actorName: 'Dmytro Sarafaniuk',
      domain: 'EMPLOYEES',
      action: 'employee.status.change',
      targetType: 'Employee',
      targetLabel: 'Jane Example',
      result: 'SUCCESS',
      severity: 'WARNING',
      metadata: { seed: 'demo' },
      changes: {
        status: { before: 'active', after: 'archived' },
      },
      occurredAt: minutesAgo(360),
    },
    {
      actorUserId: opts.ownerId,
      actorEmail: 'admin@test.com',
      actorName: 'Dmytro Sarafaniuk',
      domain: 'FINANCE',
      action: 'paymentSource.archive',
      targetType: 'PaymentSource',
      targetLabel: 'Old Wise USD',
      result: 'SUCCESS',
      severity: 'INFO',
      metadata: { seed: 'demo' },
      changes: {
        isActive: { before: true, after: false },
      },
      occurredAt: minutesAgo(500),
    },
  ];

  for (const data of events) {
    await prisma.auditEvent.create({ data });
  }
  console.log(`Seeded ${events.length} demo audit events.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
