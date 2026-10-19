import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditResult, AuditSeverity, BackupStatus, BackupType } from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { runBackup } from './backup-runner';
import { BackupDownloadService } from './backup-download.service';

/** How long a RUNNING row is still considered live before a fresh
 *  trigger is allowed to kick off a new attempt. The watchdog cron
 *  (`scripts/mark-stuck-running.ts`) handles the long tail at 2 h —
 *  this just stops two humans double-clicking inside the same backup
 *  window. 10 min comfortably covers the usual 1–2 min pg_dump +
 *  B2 round-trip. */
const TRIGGER_IN_FLIGHT_WINDOW_MS = 10 * 60 * 1000;

/** TTL for the signed download URL of a backup artifact. Short enough
 *  that a leaked link expires before it can be meaningfully re-used,
 *  long enough that a user's browser can start the download. */
const DOWNLOAD_URL_TTL_SECONDS = 120;

/** Statuses whose artifact is considered trustworthy and
 *  downloadable. RUNNING/FAILED/PENDING are explicitly refused. */
const DOWNLOADABLE_STATUSES: ReadonlySet<BackupStatus> = new Set<BackupStatus>([
  BackupStatus.SUCCEEDED,
  BackupStatus.VERIFIED,
]);

/**
 * Backups service.
 *
 * Backup creation lives entirely in `scripts/backup.ts` + the shared
 * `backup-runner`. The HTTP backend never spawns `pg_dump` and never
 * holds the write-side backup credentials. List / details / summary
 * endpoints serve rows out of `BackupRun`. The download endpoint
 * generates a short-lived B2 signed URL (through a dedicated backup
 * credential pair, isolated from the runtime key) and audits the
 * request.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly download: BackupDownloadService,
    private readonly audit: AuditEventService,
  ) {}

  async list(page = 1, limit = 25) {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.backupRun.findMany({
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.backupRun.count(),
    ]);
    return {
      data: data.map((r) => this.serialize(r)),
      total,
      page,
      limit,
    };
  }

  async summary() {
    const [last, lastVerified, lastFailed, total] = await Promise.all([
      this.prisma.backupRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.prisma.backupRun.findFirst({
        where: { status: BackupStatus.VERIFIED },
        orderBy: { lastVerifiedAt: 'desc' },
      }),
      this.prisma.backupRun.findFirst({
        where: { status: BackupStatus.FAILED },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.backupRun.count(),
    ]);
    return {
      last: last ? this.serialize(last) : null,
      lastVerified: lastVerified ? this.serialize(lastVerified) : null,
      lastFailed: lastFailed ? this.serialize(lastFailed) : null,
      total,
    };
  }

  async get(id: string) {
    const run = await this.prisma.backupRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('BackupRun not found');
    return this.serialize(run);
  }

  /**
   * Human-triggered backup from the Backups UI. Fires `runBackup` in
   * the background through the same shared runner that `scripts/
   * backup.ts` uses under cron, so the Discord + audit + advisory-lock
   * paths are identical. The HTTP response returns before the dump
   * finishes — the caller polls `GET /backups` and watches for the
   * freshly-created `MANUAL` row (triggeredBy='manual-ui') to flip
   * out of RUNNING.
   *
   * Concurrency: we refuse a new trigger when a RUNNING row younger
   * than TRIGGER_IN_FLIGHT_WINDOW_MS exists. The B2 advisory lock
   * would catch a true concurrent run anyway, but surfacing a 409
   * early keeps the Discord stream from receiving an immediate
   * `pg advisory lock held` failure on every double-click.
   */
  async trigger(
    actor: { userId: string; email?: string | null; name?: string | null },
    ctx?: { ip?: string | null; userAgent?: string | null; requestId?: string | null },
  ) {
    const inFlight = await this.prisma.backupRun.findFirst({
      where: { status: BackupStatus.RUNNING },
      orderBy: { startedAt: 'desc' },
    });
    if (inFlight) {
      const ageMs = Date.now() - inFlight.startedAt.getTime();
      if (ageMs < TRIGGER_IN_FLIGHT_WINDOW_MS) {
        await this.audit.recordSafe({
          actorUserId: actor.userId,
          actorEmail: actor.email ?? null,
          actorName: actor.name ?? null,
          domain: 'backups',
          action: 'backups.trigger',
          targetType: 'BackupRun',
          targetId: inFlight.id,
          result: AuditResult.FAILED,
          severity: AuditSeverity.WARNING,
          metadata: { reason: 'already_running', inFlightId: inFlight.id },
          ...ctx,
        });
        throw new ConflictException('Another backup is already running');
      }
    }

    const triggeredAt = new Date();
    const environment = process.env.APP_ENV ?? 'unknown';

    /* Fire and forget. Any failure is already surfaced by the shared
     * runner through Discord + a FAILED BackupRun row — we log here
     * only for the Nest log stream. Awaiting the whole run would
     * block the HTTP response for ~1–2 minutes. */
    void runBackup({
      type: BackupType.MANUAL,
      triggeredBy: 'manual-ui',
      prisma: this.prisma,
    }).catch((err) => {
      this.logger.error(
        `[backups.trigger] runBackup rejected: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    await this.audit.recordSafe({
      actorUserId: actor.userId,
      actorEmail: actor.email ?? null,
      actorName: actor.name ?? null,
      domain: 'backups',
      action: 'backups.trigger',
      targetType: 'BackupRun',
      targetId: 'pending',
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.INFO,
      metadata: {
        type: BackupType.MANUAL,
        triggeredBy: 'manual-ui',
        environment,
      },
      ...ctx,
    });

    return {
      started: true,
      triggeredAt: triggeredAt.toISOString(),
    };
  }

  /**
   * Issue a short-lived B2 signed URL for the backup artifact. Only
   * runs that have a stored `artifactKey` (any status that produced
   * an upload) can be downloaded; a FAILED run that never uploaded
   * returns 400.
   *
   * The signed URL is scoped to a single object and expires in
   * `DOWNLOAD_URL_TTL_SECONDS` seconds. The caller receives the URL
   * in the JSON response body — the CRM access token stays in the
   * `Authorization` header, so no secret enters the browser URL
   * bar, history, server-access logs or `Referer` headers.
   */
  async getDownloadUrl(
    id: string,
    actor: { userId: string; email?: string | null; name?: string | null },
    ctx?: { ip?: string | null; userAgent?: string | null; requestId?: string | null },
  ) {
    const run = await this.prisma.backupRun.findUnique({ where: { id } });
    if (!run) {
      await this.audit.recordSafe({
        actorUserId: actor.userId,
        actorEmail: actor.email ?? null,
        actorName: actor.name ?? null,
        domain: 'backups',
        action: 'backups.download',
        targetType: 'BackupRun',
        targetId: id,
        result: AuditResult.FAILED,
        severity: AuditSeverity.WARNING,
        metadata: { reason: 'not_found' },
        ...ctx,
      });
      throw new NotFoundException('BackupRun not found');
    }
    if (!run.artifactKey) {
      await this.audit.recordSafe({
        actorUserId: actor.userId,
        actorEmail: actor.email ?? null,
        actorName: actor.name ?? null,
        domain: 'backups',
        action: 'backups.download',
        targetType: 'BackupRun',
        targetId: id,
        targetLabel: run.databaseName,
        result: AuditResult.FAILED,
        severity: AuditSeverity.WARNING,
        metadata: { reason: 'no_artifact', status: run.status },
        ...ctx,
      });
      throw new BadRequestException(
        'This backup run has no artifact to download',
      );
    }

    /* Only SUCCEEDED or VERIFIED runs are downloadable. RUNNING,
     * FAILED and anything else — including transient states — are
     * refused with 400. We would rather deny a borderline case than
     * hand out a partially-written or stale dump. */
    if (!DOWNLOADABLE_STATUSES.has(run.status)) {
      await this.audit.recordSafe({
        actorUserId: actor.userId,
        actorEmail: actor.email ?? null,
        actorName: actor.name ?? null,
        domain: 'backups',
        action: 'backups.download',
        targetType: 'BackupRun',
        targetId: id,
        targetLabel: run.databaseName,
        result: AuditResult.FAILED,
        severity: AuditSeverity.WARNING,
        metadata: { reason: 'status_not_downloadable', status: run.status },
        ...ctx,
      });
      throw new BadRequestException(
        `Only SUCCEEDED or VERIFIED backups can be downloaded (current status: ${run.status.toLowerCase()}).`,
      );
    }

    const url = await this.download.getSignedUrl(
      run.artifactKey,
      DOWNLOAD_URL_TTL_SECONDS,
    );

    /* HEAD-probe the signed URL before handing it to the browser.
     * The signed URL is valid regardless of whether the object exists
     * (B2's `getDownloadAuthorization` just signs a prefix); only the
     * actual GET returns 404 for a missing key. We'd rather surface
     * that cleanly as our own 404 with a readable message than let
     * the browser open B2's own 404 HTML page. */
    let probeStatus: number | null = null;
    try {
      const probe = await fetch(url, { method: 'HEAD' });
      probeStatus = probe.status;
    } catch (err) {
      this.logger.warn(
        `Backup download probe failed for ${run.artifactKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (probeStatus === 404) {
      await this.audit.recordSafe({
        actorUserId: actor.userId,
        actorEmail: actor.email ?? null,
        actorName: actor.name ?? null,
        domain: 'backups',
        action: 'backups.download',
        targetType: 'BackupRun',
        targetId: id,
        targetLabel: run.databaseName,
        result: AuditResult.FAILED,
        severity: AuditSeverity.WARNING,
        metadata: {
          reason: 'artifact_missing_on_storage',
          artifactKey: run.artifactKey,
          status: run.status,
        },
        ...ctx,
      });
      throw new NotFoundException(
        'Backup artifact is missing on storage. The DB row still exists but the file is gone.',
      );
    }

    const expiresAt = new Date(
      Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000,
    ).toISOString();
    const fileName = run.artifactKey.split('/').pop() ?? run.artifactKey;

    await this.audit.recordSafe({
      actorUserId: actor.userId,
      actorEmail: actor.email ?? null,
      actorName: actor.name ?? null,
      domain: 'backups',
      action: 'backups.download',
      targetType: 'BackupRun',
      targetId: id,
      targetLabel: run.databaseName,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
      metadata: {
        artifactKey: run.artifactKey,
        ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
        status: run.status,
        type: run.type,
        environment: run.environment,
      },
      ...ctx,
    });

    return { url, expiresAt, fileName };
  }

  private serialize<T extends { size?: unknown }>(r: T) {
    // `size` is BigInt in Prisma — convert for JSON.
    const row = r as Record<string, unknown>;
    return {
      ...row,
      size:
        row.size !== null && row.size !== undefined
          ? String(row.size as bigint)
          : null,
    };
  }
}
