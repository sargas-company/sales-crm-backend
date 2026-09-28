import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

// Reserved system-role slugs cannot be reused for custom roles.
const RESERVED_SLUGS = new Set(['owner', 'admin_manager', 'regular_manager']);
const OWNER_SLUG = 'owner';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ system: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        label: true,
        description: true,
        system: true,
        createdAt: true,
        updatedAt: true,
        permissions: {
          select: {
            permission: {
              select: { id: true, key: true, module: true, action: true, label: true },
            },
          },
        },
        _count: { select: { users: true } },
      },
    });
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      description: r.description,
      system: r.system,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      permissions: r.permissions.map((rp) => rp.permission),
      userCount: r._count.users,
    }));
  }

  async listPermissionCatalogue() {
    return this.prisma.permission.findMany({
      orderBy: [{ module: 'asc' }, { action: 'asc' }],
      select: {
        id: true,
        key: true,
        module: true,
        action: true,
        label: true,
        description: true,
      },
    });
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  async createRole(dto: CreateRoleDto, actorId: string | null) {
    if (RESERVED_SLUGS.has(dto.name)) {
      throw new BadRequestException('RESERVED_ROLE_SLUG');
    }
    const existingByName = await this.prisma.role.findUnique({
      where: { name: dto.name },
      select: { id: true },
    });
    if (existingByName) {
      throw new BadRequestException('ROLE_NAME_TAKEN');
    }
    const permissions = await this.resolvePermissionKeys(dto.permissionKeys);

    const created = await this.prisma.role.create({
      data: {
        name: dto.name,
        label: dto.label,
        description: dto.description ?? null,
        system: false,
        permissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
      select: {
        id: true,
        name: true,
        label: true,
        description: true,
        system: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    await this.audit.log({
      actorId,
      action: 'role.create',
      targetType: 'Role',
      targetId: created.id,
      summary: {
        name: created.name,
        label: created.label,
        description: created.description,
        permissionKeys: permissions.map((p) => p.key).sort(),
      },
    });
    return { ...created, permissions, userCount: 0 };
  }

  async updateRole(id: string, dto: UpdateRoleDto, actorId: string | null) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        label: true,
        description: true,
        system: true,
        permissions: { select: { permission: { select: { id: true, key: true } } } },
      },
    });
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');

    // Slug is immutable across the board (spec §6). Sending `name` in
    // the payload is only accepted so the service can respond with the
    // dedicated `SYSTEM_ROLE_SLUG_LOCKED` code instead of the generic
    // ValidationPipe rejection.
    if (dto.name !== undefined && dto.name !== role.name) {
      throw new BadRequestException('SYSTEM_ROLE_SLUG_LOCKED');
    }

    // Owner permission set is locked (spec §6).
    if (role.name === OWNER_SLUG && dto.permissionKeys !== undefined) {
      throw new BadRequestException('OWNER_PERMISSIONS_LOCKED');
    }

    const dataLabelDesc: Record<string, unknown> = {};
    if (dto.label !== undefined) dataLabelDesc.label = dto.label;
    if (dto.description !== undefined) dataLabelDesc.description = dto.description;

    const currentKeys = new Set(role.permissions.map((rp) => rp.permission.key));
    let nextKeys: Set<string> | null = null;
    if (dto.permissionKeys !== undefined) {
      const perms = await this.resolvePermissionKeys(dto.permissionKeys);
      nextKeys = new Set(perms.map((p) => p.key));
    }

    const nothingChanged =
      Object.keys(dataLabelDesc).length === 0 &&
      (nextKeys === null || setsEqual(currentKeys, nextKeys));
    if (nothingChanged) {
      // Idempotent no-op: no audit entry, no update touch.
      return this.readSingleRole(id);
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(dataLabelDesc).length > 0) {
        await tx.role.update({ where: { id }, data: dataLabelDesc });
      }
      if (nextKeys !== null) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        const perms = await tx.permission.findMany({
          where: { key: { in: Array.from(nextKeys) } },
          select: { id: true },
        });
        if (perms.length > 0) {
          await tx.rolePermission.createMany({
            data: perms.map((p) => ({ roleId: id, permissionId: p.id })),
            skipDuplicates: true,
          });
        }
      }
    });

    const summary: Record<string, unknown> = {};
    if (dto.label !== undefined) {
      summary.label = { from: role.label, to: dto.label };
    }
    if (dto.description !== undefined) {
      summary.description = { from: role.description, to: dto.description };
    }
    if (nextKeys !== null) {
      const added = Array.from(nextKeys).filter((k) => !currentKeys.has(k)).sort();
      const removed = Array.from(currentKeys).filter((k) => !nextKeys!.has(k)).sort();
      summary.permissionKeys = { added, removed };
    }
    await this.audit.log({
      actorId,
      action: 'role.update',
      targetType: 'Role',
      targetId: id,
      summary,
    });

    return this.readSingleRole(id);
  }

  async deleteRole(id: string, actorId: string | null) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        label: true,
        system: true,
        _count: { select: { users: true } },
      },
    });
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
    if (role.system) throw new BadRequestException('SYSTEM_ROLE_UNDELETABLE');
    if (role._count.users > 0) throw new BadRequestException('ROLE_HAS_USERS');

    await this.prisma.role.delete({ where: { id } });
    await this.audit.log({
      actorId,
      action: 'role.delete',
      targetType: 'Role',
      targetId: id,
      summary: { name: role.name, label: role.label },
    });
  }

  async assignRoleToUser(userId: string, roleId: string, actorId: string | null) {
    const [user, role, actor] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          roleId: true,
          roleRef: { select: { name: true } },
        },
      }),
      this.prisma.role.findUnique({
        where: { id: roleId },
        select: { id: true, name: true },
      }),
      actorId
        ? this.prisma.user.findUnique({
            where: { id: actorId },
            select: { id: true, roleRef: { select: { name: true } } },
          })
        : Promise.resolve(null),
    ]);
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');

    // Only an Owner may grant the Owner role. Every other actor with
    // `roles:assign` can move users between non-Owner roles but cannot
    // escalate anyone (including themselves) to Owner (spec §6).
    if (role.name === OWNER_SLUG && actor?.roleRef?.name !== OWNER_SLUG) {
      throw new ForbiddenException('ONLY_OWNER_CAN_GRANT_OWNER');
    }

    // Last-Owner protection (spec §6): if the target user is currently the
    // sole Owner and is being moved away from the owner role → block.
    if (user.roleRef?.name === OWNER_SLUG && role.name !== OWNER_SLUG) {
      const ownerCount = await this.prisma.user.count({
        where: { roleRef: { name: OWNER_SLUG } },
      });
      if (ownerCount <= 1) {
        throw new BadRequestException('LAST_OWNER_LOCK');
      }
    }

    if (user.roleId === roleId) {
      // Idempotent no-op.
      return { id: user.id, email: user.email, roleId };
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { roleId },
    });
    await this.audit.log({
      actorId,
      action: 'user.role.assign',
      targetType: 'User',
      targetId: userId,
      summary: {
        email: user.email,
        roleId,
        roleName: role.name,
        previousRoleId: user.roleId,
        previousRoleName: user.roleRef?.name ?? null,
      },
    });
    return { id: user.id, email: user.email, roleId };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async resolvePermissionKeys(keys: string[]) {
    const perms = await this.prisma.permission.findMany({
      where: { key: { in: keys } },
      select: { id: true, key: true },
    });
    const foundKeys = new Set(perms.map((p) => p.key));
    const missing = keys.filter((k) => !foundKeys.has(k));
    if (missing.length > 0) {
      throw new BadRequestException(`UNKNOWN_PERMISSION_KEYS:${missing.join(',')}`);
    }
    return perms;
  }

  private async readSingleRole(id: string) {
    const r = await this.prisma.role.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        name: true,
        label: true,
        description: true,
        system: true,
        createdAt: true,
        updatedAt: true,
        permissions: {
          select: {
            permission: {
              select: { id: true, key: true, module: true, action: true, label: true },
            },
          },
        },
        _count: { select: { users: true } },
      },
    });
    return {
      id: r.id,
      name: r.name,
      label: r.label,
      description: r.description,
      system: r.system,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      permissions: r.permissions.map((rp) => rp.permission),
      userCount: r._count.users,
    };
  }
}

function setsEqual(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
