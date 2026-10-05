import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditResult } from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';
import { AuthUser } from '../auth/auth-user';
import { CredentialEncryptionService } from '../credentials-vault/encryption.service';
import { VaultRateLimiterService } from '../credentials-vault/rate-limiter.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import { RequestContext } from './credentials-profile.service';

/** Hard upper bound retained as a safety net — Admin can only tighten
 *  the limit from Settings, never loosen past this value. */
const MAX_ATTACHMENT_BYTES_ABS = 50 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENT_MB = 10;
const DOWNLOAD_LIMIT = 30;
const DOWNLOAD_WINDOW_MS = 60_000;
const ALLOWED_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const DENIED_FILENAME_PATTERNS: RegExp[] = [
  /\.(exe|bat|cmd|com|msi|scr|cpl|dll|so|dylib|app|jar|jse|js|mjs|cjs|vbs|wsf|ps1|sh|py|rb|pl|php)$/i,
];

interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface AttachmentPreview {
  id: string;
  accountId: string;
  filename: string;
  mime: string;
  size: number;
  uploadedById: string | null;
  createdAt: Date;
}

interface StoredMeta {
  filename: string;
  mime: string;
}

@Injectable()
export class CredentialsAttachmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: CredentialEncryptionService,
    private readonly audit: AuditEventService,
    private readonly rateLimit: VaultRateLimiterService,
    private readonly settings: SettingsService,
  ) {}

  /** Resolved attachment size cap, honoring the Settings override and
   *  the absolute safety ceiling. */
  async getMaxAttachmentBytes(): Promise<number> {
    const mb = await this.settings.getNumberForKey(
      SK.CREDENTIALS_MAX_ATTACHMENT_MB,
      DEFAULT_MAX_ATTACHMENT_MB,
    );
    const bytes = Math.max(1, Math.floor(mb)) * 1024 * 1024;
    return Math.min(bytes, MAX_ATTACHMENT_BYTES_ABS);
  }

  async listForAccount(accountId: string): Promise<AttachmentPreview[]> {
    const account = await this.prisma.credentialAccount.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    const rows = await this.prisma.credentialAttachment.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      select: this.metaSelect(),
    });
    return rows.map((r) => this.decodePreview(r));
  }

  async upload(
    accountId: string,
    file: UploadedFile,
    actor: AuthUser,
    context: RequestContext,
  ): Promise<AttachmentPreview> {
    if (!file || !file.buffer) throw new BadRequestException('No file provided');
    const maxBytes = await this.getMaxAttachmentBytes();
    if (file.size > maxBytes) {
      const maxMb = Math.floor(maxBytes / (1024 * 1024));
      throw new BadRequestException(
        `Attachment exceeds the ${maxMb} MB limit.`,
      );
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(`MIME type ${file.mimetype} not allowed`);
    }
    for (const rx of DENIED_FILENAME_PATTERNS) {
      if (rx.test(file.originalname)) {
        throw new BadRequestException('Executable / script filenames are not allowed');
      }
    }
    const account = await this.prisma.credentialAccount.findUnique({
      where: { id: accountId },
      select: { id: true, serviceName: true, profile: { select: { name: true } } },
    });
    if (!account) throw new NotFoundException('Account not found');

    const meta = this.enc.encryptJson({
      filename: file.originalname,
      mime: file.mimetype,
    });
    const content = this.enc.encryptBuffer(file.buffer);
    // Both blobs must share a key version — refuse if rotation happened
    // between the two calls (impossible today; belt & braces for later).
    if (meta.keyVersion !== content.keyVersion) {
      throw new BadRequestException('Encryption version mismatch between meta and content');
    }

    const row = await this.prisma.credentialAttachment.create({
      data: {
        accountId,
        encMeta: meta.ciphertext,
        encMetaIv: meta.iv,
        encMetaAuthTag: meta.authTag,
        encContent: content.ciphertext,
        encContentIv: content.iv,
        encContentAuthTag: content.authTag,
        encKeyVersion: content.keyVersion,
        encAlgorithm: content.algorithm,
        size: file.size,
        uploadedById: actor.id,
      },
      select: this.metaSelect(),
    });

    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'attachment.upload',
      targetType: 'CredentialAttachment',
      targetId: row.id,
      targetLabel: `${account.profile.name} · ${account.serviceName}`,
      result: AuditResult.SUCCESS,
      metadata: { size: file.size, mime: file.mimetype },
      ...context,
    });
    return this.decodePreview(row);
  }

  async download(id: string, actor: AuthUser, context: RequestContext) {
    this.rateLimit.consume('vault.attachment', actor.id, DOWNLOAD_LIMIT, DOWNLOAD_WINDOW_MS);
    const row = await this.prisma.credentialAttachment.findUnique({
      where: { id },
      select: {
        id: true,
        accountId: true,
        encMeta: true,
        encMetaIv: true,
        encMetaAuthTag: true,
        encContent: true,
        encContentIv: true,
        encContentAuthTag: true,
        encKeyVersion: true,
        encAlgorithm: true,
        size: true,
        account: {
          select: { serviceName: true, profile: { select: { name: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    const meta = this.enc.decryptJson<StoredMeta>({
      ciphertext: row.encMeta,
      iv: row.encMetaIv,
      authTag: row.encMetaAuthTag,
      keyVersion: row.encKeyVersion,
      algorithm: row.encAlgorithm,
    });
    const content = this.enc.decryptBuffer({
      ciphertext: row.encContent,
      iv: row.encContentIv,
      authTag: row.encContentAuthTag,
      keyVersion: row.encKeyVersion,
      algorithm: row.encAlgorithm,
    });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'attachment.download',
      targetType: 'CredentialAttachment',
      targetId: row.id,
      targetLabel: `${row.account.profile.name} · ${row.account.serviceName}`,
      result: AuditResult.SUCCESS,
      metadata: { size: row.size, mime: meta.mime },
      ...context,
    });
    return { filename: meta.filename, mime: meta.mime, content, size: row.size };
  }

  async delete(id: string, actor: AuthUser, context: RequestContext) {
    const row = await this.prisma.credentialAttachment.findUnique({
      where: { id },
      select: {
        id: true,
        accountId: true,
        account: { select: { serviceName: true, profile: { select: { name: true } } } },
      },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    await this.prisma.credentialAttachment.delete({ where: { id } });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'attachment.delete',
      targetType: 'CredentialAttachment',
      targetId: row.id,
      targetLabel: `${row.account.profile.name} · ${row.account.serviceName}`,
      result: AuditResult.SUCCESS,
      ...context,
    });
    return { id: row.id };
  }

  private metaSelect() {
    return {
      id: true,
      accountId: true,
      encMeta: true,
      encMetaIv: true,
      encMetaAuthTag: true,
      encKeyVersion: true,
      encAlgorithm: true,
      size: true,
      uploadedById: true,
      createdAt: true,
    } as const;
  }

  private decodePreview(row: {
    id: string;
    accountId: string;
    encMeta: Uint8Array;
    encMetaIv: Uint8Array;
    encMetaAuthTag: Uint8Array;
    encKeyVersion: number;
    encAlgorithm: string;
    size: number;
    uploadedById: string | null;
    createdAt: Date;
  }): AttachmentPreview {
    let meta: StoredMeta = { filename: 'attachment', mime: 'application/octet-stream' };
    try {
      meta = this.enc.decryptJson<StoredMeta>({
        ciphertext: row.encMeta,
        iv: row.encMetaIv,
        authTag: row.encMetaAuthTag,
        keyVersion: row.encKeyVersion,
        algorithm: row.encAlgorithm,
      });
    } catch {
      // Keep opaque fallback — the caller still sees size + timestamp.
    }
    return {
      id: row.id,
      accountId: row.accountId,
      filename: meta.filename,
      mime: meta.mime,
      size: row.size,
      uploadedById: row.uploadedById,
      createdAt: row.createdAt,
    };
  }
}
