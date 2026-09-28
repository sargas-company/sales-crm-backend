import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { Prisma, PrismaClient, PromptType, UserRole } from '@prisma/client';
import { JOB_GATEKEEPER_PROMPT } from '../src/ai/prompts/job-gatekeeper.prompt';
import { JOB_EVALUATION_PROMPT } from '../src/ai/prompts/job-evaluation.prompt';
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
  { module: 'job_posts',          action: 'view',   key: 'job_posts:view',          label: 'View job posts' },
  { module: 'job_posts',          action: 'create', key: 'job_posts:create',        label: 'Create job posts' },
  { module: 'job_posts',          action: 'update', key: 'job_posts:update',        label: 'Update job posts' },
  { module: 'job_posts',          action: 'delete', key: 'job_posts:delete',        label: 'Delete job posts' },
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
  { module: 'invoices',           action: 'view',   key: 'invoices:view',           label: 'View invoices' },
  { module: 'invoices',           action: 'create', key: 'invoices:create',         label: 'Create invoices' },
  { module: 'invoices',           action: 'update', key: 'invoices:update',         label: 'Update invoices' },
  { module: 'invoices',           action: 'delete', key: 'invoices:delete',         label: 'Delete invoices' },
  { module: 'counterparties',     action: 'view',   key: 'counterparties:view',     label: 'View counterparties' },
  { module: 'counterparties',     action: 'create', key: 'counterparties:create',   label: 'Create counterparties' },
  { module: 'counterparties',     action: 'update', key: 'counterparties:update',   label: 'Update counterparties' },
  { module: 'counterparties',     action: 'delete', key: 'counterparties:delete',   label: 'Delete counterparties' },
  { module: 'prompts',            action: 'view',   key: 'prompts:view',            label: 'View prompts' },
  { module: 'prompts',            action: 'create', key: 'prompts:create',          label: 'Create prompts' },
  { module: 'prompts',            action: 'update', key: 'prompts:update',          label: 'Update prompts' },
  { module: 'prompts',            action: 'delete', key: 'prompts:delete',          label: 'Delete prompts' },
  { module: 'employees',          action: 'view',   key: 'employees:view',          label: 'View employees' },
  { module: 'employees',          action: 'create', key: 'employees:create',        label: 'Create employees' },
  { module: 'employees',          action: 'update', key: 'employees:update',        label: 'Update employees' },
  { module: 'employees',          action: 'delete', key: 'employees:delete',        label: 'Delete employees' },
  { module: 'credentials',        action: 'view',   key: 'credentials:view',        label: 'View credentials list' },
  { module: 'credentials',        action: 'create', key: 'credentials:create',      label: 'Create credentials' },
  { module: 'credentials',        action: 'update', key: 'credentials:update',      label: 'Update credentials' },
  { module: 'credentials',        action: 'delete', key: 'credentials:delete',      label: 'Archive credentials' },
  { module: 'credentials',        action: 'reveal', key: 'credentials:reveal',      label: 'Reveal credential secret' },
  { module: 'credentials',        action: 'copy',   key: 'credentials:copy',        label: 'Copy credential secret' },
  { module: 'salaries',           action: 'view',   key: 'salaries:view',           label: 'View salary records' },
  { module: 'salaries',           action: 'create', key: 'salaries:create',         label: 'Create salary records' },
  { module: 'salaries',           action: 'update', key: 'salaries:update',         label: 'Update salary records' },
  { module: 'salaries',           action: 'delete', key: 'salaries:delete',         label: 'Delete salary records' },
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
  { module: 'sales_analytics',    action: 'view',   key: 'sales_analytics:view',    label: 'View sales analytics' },
  { module: 'finance_analytics',  action: 'view',   key: 'finance_analytics:view',  label: 'View finance analytics' },
  { module: 'roles',              action: 'view',   key: 'roles:view',              label: 'View roles and permissions' },
  { module: 'roles',              action: 'create', key: 'roles:create',            label: 'Create custom roles' },
  { module: 'roles',              action: 'update', key: 'roles:update',            label: 'Update roles' },
  { module: 'roles',              action: 'delete', key: 'roles:delete',            label: 'Delete custom roles' },
  { module: 'roles',              action: 'assign', key: 'roles:assign',            label: 'Assign a role to a user' },
  { module: 'settings',           action: 'view',   key: 'settings:view',           label: 'View application settings' },
  { module: 'settings',           action: 'update', key: 'settings:update',         label: 'Update application settings' },
];

// Admin Manager's slice of the catalogue: everything except finance,
// salary, payment_sources, cashflow, profit, finance_analytics,
// dashboards_finance and the whole roles admin surface.
// compensation_reviews and settings shrink to view-only.
const ADMIN_MANAGER_MODULES = new Set([
  'dashboards_sales',
  'proposals', 'platforms', 'job_posts', 'accounts',
  'leads', 'client_calls', 'client_requests',
  'invoices', 'counterparties',
  'prompts', 'employees', 'credentials',
  'sales_analytics',
]);
const ADMIN_MANAGER_EXTRA_KEYS = new Set([
  'compensation_reviews:view',
  'settings:view',
]);

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
  // 1. System roles.
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

  // 3. Bindings — connect Owner to every permission, Admin Manager to
  //    the operational slice. Regular Manager stays empty. Idempotent:
  //    delete-then-recreate for the two system roles so drift on
  //    reseed converges to the catalogue.
  const allPermissions = await prisma.permission.findMany({ select: { id: true, key: true, module: true } });

  await prisma.rolePermission.deleteMany({ where: { roleId: owner.id } });
  await prisma.rolePermission.createMany({
    data: allPermissions.map((p) => ({ roleId: owner.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  const adminManagerSet = allPermissions.filter(
    (p) => ADMIN_MANAGER_MODULES.has(p.module) || ADMIN_MANAGER_EXTRA_KEYS.has(p.key),
  );
  await prisma.rolePermission.deleteMany({ where: { roleId: adminManager.id } });
  await prisma.rolePermission.createMany({
    data: adminManagerSet.map((p) => ({ roleId: adminManager.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  console.log(
    `Seeded roles: owner, admin_manager, regular_manager; permissions: ${allPermissions.length}; ` +
      `Owner-bindings: ${allPermissions.length}; Admin-Manager-bindings: ${adminManagerSet.length}.`,
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
      role: UserRole.ADMIN,
      roleId: ownerId,
    },
    create: {
      email: 'admin@test.com',
      passwordHash,
      firstName: 'Dmytro',
      lastName: 'Sarafaniuk',
      role: UserRole.ADMIN,
      roleId: ownerId,
    },
  });

  const user2 = await prisma.user.upsert({
    where: { email: 'manager@test.com' },
    update: {
      firstName: 'Test',
      lastName: 'Manager',
      role: UserRole.MANAGER,
      roleId: adminManagerId,
    },
    create: {
      email: 'manager@test.com',
      passwordHash,
      firstName: 'Test',
      lastName: 'Manager',
      role: UserRole.MANAGER,
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
