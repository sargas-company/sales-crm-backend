import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditResult,
  CredentialProfileStatus,
  CredentialProfileType,
  Prisma,
} from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';
import { AuthUser } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCredentialProfileDto } from './dto/create-profile.dto';
import { HardDeleteProfileDto, ListCredentialProfilesDto } from './dto/list-profiles.dto';
import { UpdateCredentialProfileDto } from './dto/update-profile.dto';

// Safe metadata only — never selects encryption columns. Callers get
// exactly this shape from list/getOne/create/update.
const PROFILE_SAFE_SELECT = {
  id: true,
  name: true,
  slug: true,
  type: true,
  status: true,
  employeeId: true,
  avatarUrl: true,
  description: true,
  tags: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { accounts: true } },
} satisfies Prisma.CredentialProfileSelect;

const HARD_DELETE_KEY = 'credentials:hard_delete';

@Injectable()
export class CredentialsProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async list(query: ListCredentialProfilesDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Prisma.CredentialProfileWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { slug: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.credentialProfile.findMany({
        where,
        select: PROFILE_SAFE_SELECT,
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.credentialProfile.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async getOne(id: string) {
    const profile = await this.prisma.credentialProfile.findUnique({
      where: { id },
      select: PROFILE_SAFE_SELECT,
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  async create(dto: CreateCredentialProfileDto, actor: AuthUser, context: RequestContext) {
    const slug = await this.uniqueSlug(dto.name);
    if (dto.employeeId) {
      const exists = await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: { id: true },
      });
      if (!exists) throw new BadRequestException('employeeId does not match an Employee');
    }
    const profile = await this.prisma.credentialProfile.create({
      data: {
        name: dto.name,
        slug,
        type: dto.type,
        employeeId: dto.employeeId ?? null,
        description: dto.description ?? null,
        tags: dto.tags ?? [],
        avatarUrl: dto.avatarUrl ?? null,
        status: CredentialProfileStatus.ACTIVE,
        createdById: actor.id,
        updatedById: actor.id,
      },
      select: PROFILE_SAFE_SELECT,
    });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'profile.create',
      targetType: 'CredentialProfile',
      targetId: profile.id,
      targetLabel: profile.name,
      result: AuditResult.SUCCESS,
      metadata: { type: profile.type },
      ...context,
    });
    return profile;
  }

  async update(id: string, dto: UpdateCredentialProfileDto, actor: AuthUser, context: RequestContext) {
    const existing = await this.prisma.credentialProfile.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!existing) throw new NotFoundException('Profile not found');

    let slug = existing.slug;
    if (dto.name && dto.name !== existing.name) {
      slug = await this.uniqueSlug(dto.name, existing.id);
    }
    if (dto.employeeId) {
      const exists = await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: { id: true },
      });
      if (!exists) throw new BadRequestException('employeeId does not match an Employee');
    }

    const updated = await this.prisma.credentialProfile.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name, slug } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.employeeId !== undefined ? { employeeId: dto.employeeId ?? null } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl ?? null } : {}),
        updatedById: actor.id,
      },
      select: PROFILE_SAFE_SELECT,
    });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'profile.update',
      targetType: 'CredentialProfile',
      targetId: updated.id,
      targetLabel: updated.name,
      result: AuditResult.SUCCESS,
      metadata: { changedFields: Object.keys(dto) },
      ...context,
    });
    return updated;
  }

  async archive(id: string, actor: AuthUser, context: RequestContext) {
    const existing = await this.prisma.credentialProfile.findUnique({
      where: { id },
      select: { id: true, name: true, status: true },
    });
    if (!existing) throw new NotFoundException('Profile not found');
    if (existing.status === CredentialProfileStatus.ARCHIVED) {
      return this.getOne(id);
    }
    const updated = await this.prisma.credentialProfile.update({
      where: { id },
      data: { status: CredentialProfileStatus.ARCHIVED, updatedById: actor.id },
      select: PROFILE_SAFE_SELECT,
    });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'profile.archive',
      targetType: 'CredentialProfile',
      targetId: updated.id,
      targetLabel: updated.name,
      result: AuditResult.SUCCESS,
      ...context,
    });
    return updated;
  }

  async restore(id: string, actor: AuthUser, context: RequestContext) {
    const existing = await this.prisma.credentialProfile.findUnique({
      where: { id },
      select: { id: true, name: true, status: true },
    });
    if (!existing) throw new NotFoundException('Profile not found');
    const updated = await this.prisma.credentialProfile.update({
      where: { id },
      data: { status: CredentialProfileStatus.ACTIVE, updatedById: actor.id },
      select: PROFILE_SAFE_SELECT,
    });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'profile.restore',
      targetType: 'CredentialProfile',
      targetId: updated.id,
      targetLabel: updated.name,
      result: AuditResult.SUCCESS,
      ...context,
    });
    return updated;
  }

  async hardDelete(
    id: string,
    dto: HardDeleteProfileDto,
    actor: AuthUser,
    context: RequestContext,
  ) {
    if (!actor.permissions.has(HARD_DELETE_KEY)) {
      await this.audit.record({
        actorUserId: actor.id,
        domain: 'credentials',
        action: 'profile.hard_delete',
        targetType: 'CredentialProfile',
        targetId: id,
        result: AuditResult.DENIED,
        metadata: { reason: 'missing credentials:hard_delete' },
        ...context,
      });
      throw new ForbiddenException('Hard delete requires credentials:hard_delete.');
    }
    const existing = await this.prisma.credentialProfile.findUnique({
      where: { id },
      select: { id: true, name: true, _count: { select: { accounts: true } } },
    });
    if (!existing) throw new NotFoundException('Profile not found');
    if (dto.confirmation !== existing.name) {
      await this.audit.record({
        actorUserId: actor.id,
        domain: 'credentials',
        action: 'profile.hard_delete',
        targetType: 'CredentialProfile',
        targetId: existing.id,
        targetLabel: existing.name,
        result: AuditResult.DENIED,
        metadata: { reason: 'confirmation mismatch' },
        ...context,
      });
      throw new BadRequestException('Confirmation does not match profile name.');
    }
    await this.prisma.credentialProfile.delete({ where: { id } });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'profile.hard_delete',
      targetType: 'CredentialProfile',
      targetId: existing.id,
      targetLabel: existing.name,
      result: AuditResult.SUCCESS,
      metadata: { accountsRemoved: existing._count.accounts },
      ...context,
    });
    return { id: existing.id };
  }

  /**
   * Slug from name; if a collision would occur, append -2, -3, …
   */
  private async uniqueSlug(name: string, excludeId?: string): Promise<string> {
    const base = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'profile';
    let candidate = base;
    let n = 1;
    while (true) {
      const clash = await this.prisma.credentialProfile.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!clash || clash.id === excludeId) return candidate;
      n += 1;
      candidate = `${base}-${n}`;
      if (n > 500) throw new Error('unable to allocate profile slug');
    }
  }
}

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}
