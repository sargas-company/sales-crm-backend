import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { StorageBucket } from '../storage/storage.types';
import { AuditEventService } from '../audit-event/audit-event.service';
import { AuditResult } from '@prisma/client';

const MAX_BYTES = 50 * 1024 * 1024;

export interface UploadInput {
  employeeId: string;
  file: Express.Multer.File;
  actorUserId: string;
}

/**
 * Business logic for Employee → EmployeeAttachment lifecycle. Thin
 * wrapper around StorageService: enforce size limit, resolve a safe
 * object key, upload to Backblaze, mirror the metadata in Postgres,
 * record audit. Delete flow is symmetric: pull the row, drop the B2
 * object, remove the row.
 *
 * Access control lives in the controller (`@RequirePermission`); this
 * service trusts the caller for the permission bit but still validates
 * the employee row exists so a bad client gets a 404 rather than a
 * dangling B2 object.
 */
@Injectable()
export class EmployeeAttachmentsService {
  private readonly logger = new Logger(EmployeeAttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditEventService,
  ) {}

  async list(employeeId: string) {
    await this.ensureEmployeeExists(employeeId);
    const rows = await this.prisma.employeeAttachment.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      include: {
        uploadedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      originalName: row.originalName,
      mimeType: row.mimeType,
      size: row.size,
      createdAt: row.createdAt,
      uploadedBy: row.uploadedBy
        ? {
            id: row.uploadedBy.id,
            name: `${row.uploadedBy.firstName} ${row.uploadedBy.lastName}`.trim(),
            email: row.uploadedBy.email,
          }
        : null,
    }));
  }

  async upload(input: UploadInput) {
    if (!input.file) throw new BadRequestException('file is required');
    if (input.file.size === 0) {
      throw new BadRequestException('file is empty');
    }
    if (input.file.size > MAX_BYTES) {
      throw new BadRequestException(
        `file exceeds the 50 MB limit (got ${input.file.size} bytes)`,
      );
    }
    await this.ensureEmployeeExists(input.employeeId);

    const safeOriginal = this.sanitizeFileName(input.file.originalname);
    const storageKey = `employees/${input.employeeId}/${randomUUID()}-${safeOriginal}`;

    const uploaded = await this.storage.upload({
      bucket: StorageBucket.EMPLOYEE_ATTACHMENTS,
      fileName: storageKey,
      buffer: input.file.buffer,
      mimeType: input.file.mimetype || 'application/octet-stream',
    });

    const row = await this.prisma.employeeAttachment.create({
      data: {
        employeeId: input.employeeId,
        originalName: input.file.originalname,
        storageKey: uploaded.key,
        mimeType: input.file.mimetype || 'application/octet-stream',
        size: input.file.size,
        uploadedById: input.actorUserId,
      },
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      domain: 'EMPLOYEES',
      action: 'employee.attachment.upload',
      targetType: 'EmployeeAttachment',
      targetId: row.id,
      targetLabel: input.file.originalname,
      result: AuditResult.SUCCESS,
      metadata: { employeeId: input.employeeId, size: input.file.size },
    });

    return { id: row.id };
  }

  async getDownloadUrl(employeeId: string, attachmentId: string, actorUserId: string) {
    const row = await this.loadRowOr404(employeeId, attachmentId);
    // Force browser-side "save as" instead of inline preview — HTML, SVG,
    // text and images all open inline otherwise, which the UI's download
    // button is not supposed to do.
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(row.originalName)}`;
    const url = await this.storage.getDownloadUrl(
      StorageBucket.EMPLOYEE_ATTACHMENTS,
      row.storageKey,
      undefined,
      disposition,
    );
    await this.audit.record({
      actorUserId,
      domain: 'EMPLOYEES',
      action: 'employee.attachment.download_url',
      targetType: 'EmployeeAttachment',
      targetId: row.id,
      targetLabel: row.originalName,
      result: AuditResult.SUCCESS,
      metadata: { employeeId },
    });
    return { url, fileName: row.originalName };
  }

  async remove(employeeId: string, attachmentId: string, actorUserId: string) {
    const row = await this.loadRowOr404(employeeId, attachmentId);
    try {
      await this.storage.deleteByName(
        StorageBucket.EMPLOYEE_ATTACHMENTS,
        row.storageKey,
      );
    } catch (err) {
      // Don't block DB cleanup on a B2 404 — the object may already
      // be gone (double-delete, stale row). Surface other errors.
      const msg = (err as Error).message || 'B2 delete failed';
      if (!/not found|404/i.test(msg)) {
        throw err;
      }
      this.logger.warn(
        `[employee-attachments] B2 object already absent for ${row.storageKey}: ${msg}`,
      );
    }
    await this.prisma.employeeAttachment.delete({ where: { id: row.id } });
    await this.audit.record({
      actorUserId,
      domain: 'EMPLOYEES',
      action: 'employee.attachment.delete',
      targetType: 'EmployeeAttachment',
      targetId: row.id,
      targetLabel: row.originalName,
      result: AuditResult.SUCCESS,
      metadata: { employeeId },
    });
    return { id: row.id };
  }

  private async ensureEmployeeExists(employeeId: string): Promise<void> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!emp) throw new NotFoundException('Employee not found');
  }

  private async loadRowOr404(employeeId: string, attachmentId: string) {
    const row = await this.prisma.employeeAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (!row || row.employeeId !== employeeId) {
      throw new NotFoundException('Attachment not found');
    }
    return row;
  }

  private sanitizeFileName(name: string): string {
    return name
      .replace(/[^\w.\-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 160);
  }
}
