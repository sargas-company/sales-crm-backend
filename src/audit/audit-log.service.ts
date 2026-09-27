import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { redactSummary } from './redact';

/**
 * Whitelist of allowed audit actions during this feature. Any future
 * mutation flow that needs an entry adds its own key here.
 */
export type AuditAction =
  | 'role.create'
  | 'role.update'
  | 'role.delete'
  | 'user.role.assign';

export type AuditTargetType = 'Role' | 'User';

export interface AuditLogEntry {
  actorId?: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  summary?: Record<string, unknown>;
}

/**
 * Central helper for role-and-permission audit writes. The
 * `summary` payload is passed through `redactSummary` before it
 * lands in Postgres so a caller cannot accidentally leak a
 * password, hash, token or refresh-token via the diff (spec §3.4).
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditLogEntry) {
    const summary = redactSummary(entry.summary);
    return this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        summary:
          summary === undefined
            ? Prisma.JsonNull
            : (summary as Prisma.InputJsonValue),
      },
    });
  }
}
