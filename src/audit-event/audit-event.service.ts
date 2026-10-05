import { Injectable } from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  AuditSeverity,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redactMetadata, SafeChanges } from './audit-sanitizer';

/**
 * Application-wide, append-only audit stream.
 *
 * Rules enforced here:
 *   • Append-only. No `update`/`delete` is exposed.
 *   • `metadata` is passed through {@link redactMetadata} so a caller
 *     cannot leak a password/token/hash via the JSON blob.
 *   • `changes` is passed through the same filter.
 *   • Writing itself must never recurse into another audit write.
 *   • Secrets NEVER go in `metadata` or `changes`. Callers pass shape
 *     (which fields changed, how a status flipped) — not values.
 *   • `targetLabel` is a sanitized snapshot so the row still reads
 *     correctly after the target row is archived / deleted.
 *   • `actorEmail`/`actorName` are optional snapshots that survive a
 *     user hard-delete.
 */
export interface AuditEventEntry {
  actorUserId?: string | null;
  actorType?: AuditActorType;
  actorEmail?: string | null;
  actorName?: string | null;
  domain: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  targetHref?: string | null;
  result: AuditResult;
  severity?: AuditSeverity;
  changes?: SafeChanges | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

@Injectable()
export class AuditEventService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEventEntry) {
    const safeMetadata = redactMetadata(entry.metadata ?? undefined);
    const safeChanges = redactMetadata(
      (entry.changes as Record<string, unknown> | undefined) ?? undefined,
    );
    return this.prisma.auditEvent.create({
      data: {
        actorUserId: entry.actorUserId ?? null,
        actorType: entry.actorType ?? AuditActorType.USER,
        actorEmail: entry.actorEmail ?? null,
        actorName: entry.actorName ?? null,
        domain: entry.domain,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel ?? null,
        targetHref: entry.targetHref ?? null,
        result: entry.result,
        severity: entry.severity ?? AuditSeverity.INFO,
        changes:
          safeChanges === undefined
            ? Prisma.JsonNull
            : (safeChanges as Prisma.InputJsonValue),
        metadata:
          safeMetadata === undefined
            ? Prisma.JsonNull
            : (safeMetadata as Prisma.InputJsonValue),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  /**
   * Fire-and-forget record() that never bubbles an error out of the
   * caller. Business logic must never fail because an audit write
   * failed — use this when the audit call is after the real action.
   */
  async recordSafe(entry: AuditEventEntry) {
    try {
      await this.record(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[audit] failed to record event', entry.action, err);
    }
  }
}
