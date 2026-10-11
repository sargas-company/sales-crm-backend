import { randomUUID } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { join, resolve } from 'path';

import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
	NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

const UPLOAD_ROOT = resolve(
	process.env.ATTACHMENTS_DIR ?? join(process.cwd(), 'uploads', 'attachments'),
);

export type AttachmentOwnerType = 'lead' | 'client';

@Injectable()
export class AttachmentsService {
	private readonly logger = new Logger(AttachmentsService.name);

	constructor(private readonly prisma: PrismaService) {}

	async upload(opts: {
		ownerType: AttachmentOwnerType;
		ownerId: string;
		file: Express.Multer.File;
		uploadedById: string | null;
	}) {
		if (!opts.file || !opts.file.buffer || opts.file.size === 0) {
			throw new BadRequestException('No file provided');
		}
		await this.assertOwnerExists(opts.ownerType, opts.ownerId);

		const ownerDir = this.ownerDir(opts.ownerType, opts.ownerId);
		await fs.mkdir(ownerDir, { recursive: true });

		// Preserve the extension so a direct filesystem browse still
		// hints at the type; prefix with a UUID so colliding names
		// from different uploads stay distinct.
		const safeOriginal = sanitiseName(opts.file.originalname);
		const diskName = `${randomUUID()}_${safeOriginal}`;
		const storageKey = this.relKey(opts.ownerType, opts.ownerId, diskName);
		const absPath = join(UPLOAD_ROOT, storageKey);

		await fs.writeFile(absPath, opts.file.buffer);

		try {
			const row = await this.prisma.attachment.create({
				data: {
					leadId: opts.ownerType === 'lead' ? opts.ownerId : null,
					clientId: opts.ownerType === 'client' ? opts.ownerId : null,
					originalName: opts.file.originalname.slice(0, 255),
					storageKey,
					mimeType: opts.file.mimetype || 'application/octet-stream',
					size: opts.file.size,
					uploadedById: opts.uploadedById,
				},
			});
			return this.serialise(row);
		} catch (err) {
			// DB write failed → clean up the orphan file.
			await fs.unlink(absPath).catch(() => undefined);
			throw err;
		}
	}

	async list(ownerType: AttachmentOwnerType, ownerId: string) {
		await this.assertOwnerExists(ownerType, ownerId);
		const rows = await this.prisma.attachment.findMany({
			where:
				ownerType === 'lead'
					? { leadId: ownerId }
					: { clientId: ownerId },
			orderBy: { createdAt: 'desc' },
			include: {
				uploadedBy: {
					select: { id: true, firstName: true, lastName: true },
				},
			},
		});
		return rows.map((r) => this.serialise(r));
	}

	async openForDownload(id: string, userId: string | null) {
		const row = await this.prisma.attachment.findUnique({ where: { id } });
		if (!row) throw new NotFoundException('Attachment not found');
		await this.assertUserCan(userId, this.ownerOf(row), 'view');
		const absPath = join(UPLOAD_ROOT, row.storageKey);
		// Fail fast when the on-disk file is missing — the row stays
		// so an operator can decide what to do.
		await fs.access(absPath).catch(() => {
			throw new NotFoundException('Attachment file is missing');
		});
		return {
			stream: createReadStream(absPath),
			filename: row.originalName,
			mimeType: row.mimeType,
			size: row.size,
		};
	}

	async remove(id: string, userId: string | null) {
		const row = await this.prisma.attachment.findUnique({ where: { id } });
		if (!row) throw new NotFoundException('Attachment not found');
		await this.assertUserCan(userId, this.ownerOf(row), 'update');
		await this.prisma.attachment.delete({ where: { id } });
		// Best-effort unlink; DB row is already gone so even if this
		// fails the UI is consistent — orphan files can be reaped
		// later by a sweep.
		await fs
			.unlink(join(UPLOAD_ROOT, row.storageKey))
			.catch((err) =>
				this.logger.warn(
					`Could not unlink attachment file ${row.storageKey}: ${(err as Error).message}`,
				),
			);
	}

	/**
	 * Resolve an Attachment row to its logical owner. The DB CHECK
	 * guarantees exactly one of leadId/clientId is non-null, so this
	 * is a total function. If both are null (should never happen),
	 * `clientId` wins by alphabetical fallback.
	 */
	private ownerOf(row: {
		leadId: string | null;
		clientId: string | null;
	}): AttachmentOwnerType {
		return row.leadId ? 'lead' : 'client';
	}

	/**
	 * Dynamic permission check for shared `/attachments/:id/*` routes.
	 * The required key is `{owner}s:{action}` — a Lead-attached file
	 * is governed by leads:*, a Client-attached file by clients:*.
	 * This exists because `@RequirePermission` is static per handler
	 * and cannot read the owner off the attachment row.
	 */
	private async assertUserCan(
		userId: string | null,
		ownerType: AttachmentOwnerType,
		action: 'view' | 'update',
	): Promise<void> {
		if (!userId) throw new ForbiddenException('Not authenticated');
		const required = `${ownerType}s:${action}`;
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: {
				roleRef: {
					select: {
						permissions: {
							select: { permission: { select: { key: true } } },
						},
					},
				},
			},
		});
		if (!user?.roleRef) {
			throw new ForbiddenException('Insufficient permissions');
		}
		const granted = new Set(
			user.roleRef.permissions.map((rp) => rp.permission.key),
		);
		if (!granted.has(required)) {
			throw new ForbiddenException('Insufficient permissions');
		}
	}

	private async assertOwnerExists(type: AttachmentOwnerType, id: string) {
		if (type === 'lead') {
			const lead = await this.prisma.lead.findUnique({
				where: { id },
				select: { id: true },
			});
			if (!lead) throw new NotFoundException('Lead not found');
		} else {
			const client = await this.prisma.client.findUnique({
				where: { id },
				select: { id: true },
			});
			if (!client) throw new NotFoundException('Client not found');
		}
	}

	private ownerDir(type: AttachmentOwnerType, id: string): string {
		return join(UPLOAD_ROOT, this.ownerKeyPrefix(type, id));
	}
	private ownerKeyPrefix(type: AttachmentOwnerType, id: string): string {
		return type === 'lead' ? `leads/${id}` : `clients/${id}`;
	}
	private relKey(
		type: AttachmentOwnerType,
		ownerId: string,
		diskName: string,
	): string {
		return `${this.ownerKeyPrefix(type, ownerId)}/${diskName}`;
	}

	private serialise(row: {
		id: string;
		leadId: string | null;
		clientId: string | null;
		originalName: string;
		mimeType: string;
		size: number;
		uploadedById: string | null;
		createdAt: Date;
		uploadedBy?: { id: string; firstName: string; lastName: string } | null;
	}) {
		return {
			id: row.id,
			ownerType: (row.leadId ? 'lead' : 'client') as AttachmentOwnerType,
			ownerId: (row.leadId ?? row.clientId)!,
			originalName: row.originalName,
			mimeType: row.mimeType,
			size: row.size,
			uploadedById: row.uploadedById,
			uploadedBy: row.uploadedBy
				? {
						id: row.uploadedBy.id,
						firstName: row.uploadedBy.firstName,
						lastName: row.uploadedBy.lastName,
					}
				: null,
			createdAt: row.createdAt.toISOString(),
		};
	}
}

/* Keep slashes and dangerous characters out of the on-disk name;
 * cap at 128 chars so a maliciously long original doesn't blow up
 * the filesystem. */
function sanitiseName(raw: string): string {
	const cleaned = (raw || 'file')
		.replace(/[\\\/\0]/g, '_')
		.replace(/\s+/g, '_')
		.replace(/[^A-Za-z0-9._\-]/g, '')
		.slice(0, 128);
	return cleaned || 'file';
}
