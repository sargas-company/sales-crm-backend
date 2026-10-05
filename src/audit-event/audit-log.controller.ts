import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditResult, AuditSeverity, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PrismaService } from '../prisma/prisma.service';

const AUDIT_DOMAINS = [
  'AUTH',
  'CREDENTIALS',
  'FINANCE',
  'RBAC',
  'SETTINGS',
  'EMPLOYEES',
  'PROJECTS',
  'CRM',
] as const;

type AuditDomain = (typeof AUDIT_DOMAINS)[number];

// Group categories map to one or more domains. Keeping this in the
// controller means the frontend can request a category without
// re-encoding the mapping.
const CATEGORY_DOMAINS: Record<string, AuditDomain[]> = {
  all: [...AUDIT_DOMAINS],
  access: ['AUTH', 'RBAC'],
  financial: ['FINANCE'],
  data: ['SETTINGS', 'EMPLOYEES', 'PROJECTS', 'CRM'],
  sensitive: ['CREDENTIALS'],
};

class ListAuditLogDto {
  @IsOptional()
  @IsIn(Object.keys(CATEGORY_DOMAINS))
  category?: keyof typeof CATEGORY_DOMAINS;

  @IsOptional()
  @IsString()
  domain?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsEnum(AuditResult)
  result?: AuditResult;

  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;

  @IsOptional()
  @IsString()
  actorUserId?: string;

  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsString()
  q?: string; // text search over actorName/actorEmail/targetLabel/action

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class SummaryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

@ApiTags('Audit Log')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Global stream ─────────────────────────────────────────────────

  /** Paginated newest-first list. Heavy fields (full metadata/changes)
   *  are returned so the UI can render the row preview in one call —
   *  they are already sanitised at write time. */
  @Get('events')
  @RequirePermission('audit_logs:view')
  @ApiOperation({
    summary:
      'List audit events (append-only, filterable, newest first by default).',
  })
  async list(@Query() query: ListAuditLogDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const sort = query.sort ?? 'desc';

    const domainFilter = (() => {
      if (query.domain) return { domain: query.domain };
      if (query.category) {
        const domains = CATEGORY_DOMAINS[query.category];
        return { domain: { in: domains } };
      }
      return {};
    })();

    const search: Prisma.AuditEventWhereInput | undefined = query.q
      ? {
          OR: [
            { actorEmail: { contains: query.q, mode: 'insensitive' } },
            { actorName: { contains: query.q, mode: 'insensitive' } },
            { targetLabel: { contains: query.q, mode: 'insensitive' } },
            { action: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : undefined;

    const where: Prisma.AuditEventWhereInput = {
      ...domainFilter,
      ...(query.action ? { action: query.action } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(search ?? {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { occurredAt: sort },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    const data = await this.hydrateActors(rows);
    return { data, total, page, limit };
  }

  /** Single event with its full `changes` + `metadata` payload. */
  @Get('events/:id')
  @RequirePermission('audit_logs:view')
  @ApiOperation({ summary: 'Audit event detail by id.' })
  async detail(@Param('id') id: string) {
    const event = await this.prisma.auditEvent.findUnique({ where: { id } });
    if (!event) throw new NotFoundException('Audit event not found');
    const [hydrated] = await this.hydrateActors([event]);
    return hydrated;
  }

  /**
   * Fills `actorEmail`/`actorName` from the current User row if the
   * audit entry did not snapshot them (i.e. the module injected only
   * `actorUserId`). Deleted users keep whatever snapshot was written.
   */
  private async hydrateActors<T extends {
    actorUserId: string | null;
    actorEmail: string | null;
    actorName: string | null;
  }>(rows: T[]): Promise<T[]> {
    const missingIds = Array.from(
      new Set(
        rows
          .filter((r) => r.actorUserId && (!r.actorEmail || !r.actorName))
          .map((r) => r.actorUserId!),
      ),
    );
    if (missingIds.length === 0) return rows;
    const users = await this.prisma.user.findMany({
      where: { id: { in: missingIds } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    const map = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      if (!r.actorUserId) return r;
      const u = map.get(r.actorUserId);
      if (!u) return r;
      return {
        ...r,
        actorEmail: r.actorEmail ?? u.email,
        actorName:
          r.actorName ??
          (`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email),
      };
    });
  }

  /** KPIs for the All Activity hero. All counts respect the (optional)
   *  date range the UI selected. */
  @Get('summary')
  @RequirePermission('audit_logs:view')
  @ApiOperation({ summary: 'Audit KPIs — counts for the hero header.' })
  async summary(@Query() query: SummaryDto) {
    const occurredAt =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;
    const base: Prisma.AuditEventWhereInput = occurredAt ? { occurredAt } : {};

    const [
      total,
      sensitive,
      financial,
      failedOrDenied,
      roleChanges,
      critical,
    ] = await this.prisma.$transaction([
      this.prisma.auditEvent.count({ where: base }),
      this.prisma.auditEvent.count({
        where: { ...base, domain: 'CREDENTIALS' },
      }),
      this.prisma.auditEvent.count({ where: { ...base, domain: 'FINANCE' } }),
      this.prisma.auditEvent.count({
        where: {
          ...base,
          result: { in: [AuditResult.FAILED, AuditResult.DENIED] },
        },
      }),
      this.prisma.auditEvent.count({ where: { ...base, domain: 'RBAC' } }),
      this.prisma.auditEvent.count({
        where: { ...base, severity: AuditSeverity.CRITICAL },
      }),
    ]);
    return {
      total,
      sensitive,
      financial,
      failedOrDenied,
      roleChanges,
      critical,
    };
  }

  /** Distinct actors in the audit log — populates the actor filter. */
  @Get('actors')
  @RequirePermission('audit_logs:view')
  @ApiOperation({ summary: 'Distinct actors who appear in the audit log.' })
  async actors() {
    const rows = await this.prisma.auditEvent.findMany({
      distinct: ['actorUserId'],
      where: { actorUserId: { not: null } },
      orderBy: { occurredAt: 'desc' },
      take: 500,
      select: {
        actorUserId: true,
        actorEmail: true,
        actorName: true,
      },
    });
    const seen = new Set<string>();
    const uniq: Array<{
      actorUserId: string;
      actorEmail: string | null;
      actorName: string | null;
    }> = [];
    for (const row of rows) {
      if (!row.actorUserId || seen.has(row.actorUserId)) continue;
      seen.add(row.actorUserId);
      uniq.push({
        actorUserId: row.actorUserId,
        actorEmail: row.actorEmail ?? null,
        actorName: row.actorName ?? null,
      });
    }
    return { data: uniq };
  }

  // ─── Credentials-profile scoped timeline ───────────────────────────

  /**
   * Returns audit events scoped to a single credential profile and
   * its accounts/attachments. Gated by `credentials:view` so an Admin
   * Manager with Credentials access can review a profile's history
   * without being granted the global `audit_logs:view` permission.
   */
  @Get('profiles/:profileId')
  @RequirePermission('credentials:view')
  @ApiOperation({ summary: 'Audit timeline for one credential profile.' })
  async forProfile(@Param('profileId') profileId: string) {
    const profile = await this.prisma.credentialProfile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        accounts: { select: { id: true } },
      },
    });
    if (!profile) throw new NotFoundException('Credential profile not found');

    const accountIds = profile.accounts.map((a) => a.id);
    const ors: Prisma.AuditEventWhereInput[] = [
      { targetType: 'CredentialProfile', targetId: profile.id },
    ];
    if (accountIds.length > 0) {
      ors.push({ targetType: 'CredentialAccount', targetId: { in: accountIds } });
      // Attachment events carry `accountId` in metadata — grab everything
      // tagged as an attachment and filter by metadata in-memory. The
      // dataset is small (one profile).
      ors.push({ targetType: 'CredentialAttachment' });
    }

    const rows = await this.prisma.auditEvent.findMany({
      where: {
        domain: 'CREDENTIALS',
        OR: ors,
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });

    const accountIdSet = new Set(accountIds);
    const scoped = rows.filter((e) => {
      if (e.targetType !== 'CredentialAttachment') return true;
      const metaAccount = (e.metadata as Record<string, unknown> | null)?.accountId;
      return typeof metaAccount === 'string' && accountIdSet.has(metaAccount);
    });
    return { data: scoped };
  }
}
