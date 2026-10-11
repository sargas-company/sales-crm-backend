import { describe, it, expect, beforeEach } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AttachmentsService } from './attachments.service';
import { PrismaService } from '../prisma/prisma.service';

/* Dynamic-ownership permission check for /attachments/:id/download
 * and DELETE /attachments/:id. These endpoints resolve the owner
 * (lead | client) from the row and demand the matching capability
 * (`leads:view` / `clients:view` for download, `*:update` for
 * delete). No HTTP layer is spun up — the service's own guard is
 * what the controller calls into. */

type Role = { key: string }[]
const prismaStub = (opts: {
	attachment: { leadId: string | null; clientId: string | null } | null
	userRole: Role | null
}): PrismaService =>
	({
		attachment: {
			findUnique: async () =>
				opts.attachment
					? {
							id: 'att-1',
							originalName: 't.pdf',
							storageKey: 'x',
							mimeType: 'application/pdf',
							size: 1,
							uploadedById: null,
							createdAt: new Date(),
							...opts.attachment,
						}
					: null,
			delete: async () => undefined,
		},
		user: {
			findUnique: async () =>
				opts.userRole === null
					? null
					: {
							roleRef: {
								permissions: opts.userRole.map((p) => ({
									permission: { key: p.key },
								})),
							},
						},
		},
	}) as unknown as PrismaService

const run = async (fn: () => Promise<unknown>) => {
	try {
		await fn()
		return { ok: true as const }
	} catch (err) {
		return { ok: false as const, err }
	}
}

describe('AttachmentsService — dynamic permission check', () => {
	describe('Lead-attached file', () => {
		const owner = { leadId: 'lead-1', clientId: null }

		it('download: leads:view granted → passes owner guard (fails later on fs, which is expected)', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: owner, userRole: [{ key: 'leads:view' }] }),
			)
			const r = await run(() => svc.openForDownload('att-1', 'u-1'))
			// Owner guard passed, so the next hop (filesystem access)
			// is what trips the test — anything OTHER than Forbidden
			// means the authorization layer let the call through.
			expect(r.ok).toBe(false)
			if (!r.ok) {
				expect(r.err).not.toBeInstanceOf(ForbiddenException)
			}
		})

		it('download: only clients:view → Forbidden (cross-domain)', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: owner, userRole: [{ key: 'clients:view' }] }),
			)
			await expect(svc.openForDownload('att-1', 'u-1')).rejects.toBeInstanceOf(
				ForbiddenException,
			)
		})

		it('download: no view key → Forbidden', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: owner, userRole: [{ key: 'leads:update' }] }),
			)
			await expect(svc.openForDownload('att-1', 'u-1')).rejects.toBeInstanceOf(
				ForbiddenException,
			)
		})

		it('delete: leads:update granted → passes guard', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: owner, userRole: [{ key: 'leads:update' }] }),
			)
			await expect(svc.remove('att-1', 'u-1')).resolves.toBeUndefined()
		})

		it('delete: only clients:update → Forbidden', async () => {
			const svc = new AttachmentsService(
				prismaStub({
					attachment: owner,
					userRole: [{ key: 'clients:update' }],
				}),
			)
			await expect(svc.remove('att-1', 'u-1')).rejects.toBeInstanceOf(
				ForbiddenException,
			)
		})

		it('delete: only leads:view (not :update) → Forbidden', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: owner, userRole: [{ key: 'leads:view' }] }),
			)
			await expect(svc.remove('att-1', 'u-1')).rejects.toBeInstanceOf(
				ForbiddenException,
			)
		})
	})

	describe('Client-attached file', () => {
		const owner = { leadId: null, clientId: 'client-1' }

		it('download: clients:view granted → passes owner guard', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: owner, userRole: [{ key: 'clients:view' }] }),
			)
			const r = await run(() => svc.openForDownload('att-1', 'u-1'))
			expect(r.ok).toBe(false)
			if (!r.ok) {
				expect(r.err).not.toBeInstanceOf(ForbiddenException)
			}
		})

		it('download: only leads:view → Forbidden (cross-domain)', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: owner, userRole: [{ key: 'leads:view' }] }),
			)
			await expect(svc.openForDownload('att-1', 'u-1')).rejects.toBeInstanceOf(
				ForbiddenException,
			)
		})

		it('delete: clients:update granted → passes', async () => {
			const svc = new AttachmentsService(
				prismaStub({
					attachment: owner,
					userRole: [{ key: 'clients:update' }],
				}),
			)
			await expect(svc.remove('att-1', 'u-1')).resolves.toBeUndefined()
		})

		it('delete: only leads:update → Forbidden', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: owner, userRole: [{ key: 'leads:update' }] }),
			)
			await expect(svc.remove('att-1', 'u-1')).rejects.toBeInstanceOf(
				ForbiddenException,
			)
		})
	})

	describe('Shared cases', () => {
		it('missing attachment → NotFound (checked BEFORE perms)', async () => {
			const svc = new AttachmentsService(
				prismaStub({ attachment: null, userRole: [{ key: 'leads:view' }] }),
			)
			await expect(svc.openForDownload('att-x', 'u-1')).rejects.toBeInstanceOf(
				NotFoundException,
			)
		})

		it('download: no userId (not authenticated) → Forbidden', async () => {
			const svc = new AttachmentsService(
				prismaStub({
					attachment: { leadId: 'lead-1', clientId: null },
					userRole: [{ key: 'leads:view' }],
				}),
			)
			await expect(svc.openForDownload('att-1', null)).rejects.toBeInstanceOf(
				ForbiddenException,
			)
		})

		it('download: user has no role → Forbidden', async () => {
			const svc = new AttachmentsService(
				prismaStub({
					attachment: { leadId: 'lead-1', clientId: null },
					userRole: null,
				}),
			)
			await expect(svc.openForDownload('att-1', 'u-1')).rejects.toBeInstanceOf(
				ForbiddenException,
			)
		})
	})
})
