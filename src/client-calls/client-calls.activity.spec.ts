import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { ClientCallClientType, PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { ClientCallsService } from './client-calls.service';
import type { CreateClientCallDto } from './dto/create-client-call.dto';

/* Verifies ClientCall.create emits a `call_created` AuditEvent on
 * the correct owner timeline (Lead / Client / ClientRequest). The
 * event payload must carry callId + scheduledAt only — no title /
 * notes / meeting URL. */

const prisma = new PrismaClient();

type RecordedEntry = Parameters<AuditEventService['record']>[0];
const recorded: RecordedEntry[] = [];
const audit = {
	recordSafe: async (entry: RecordedEntry) => {
		recorded.push(entry);
	},
	record: async (entry: RecordedEntry) => {
		recorded.push(entry);
	},
} as unknown as AuditEventService;

const notificationsStub = {
	createEvent: async () => undefined,
} as unknown as import('../notification/notification.service').NotificationService;

const svc = new ClientCallsService(
	prisma as unknown as PrismaService,
	audit,
	notificationsStub,
);

const TAG = `cc-activity-${randomUUID().slice(0, 8)}`;
let creatorId: string;
let leadId: string;
let clientId: string;
let crId: string | null = null;
const createdCallIds: string[] = [];

beforeAll(async () => {
	const existing = await prisma.user.findFirst({ select: { id: true } });
	if (existing) {
		creatorId = existing.id;
	} else {
		const u = await prisma.user.create({
			data: {
				email: `${TAG}@test.local`,
				firstName: 'Spec',
				lastName: 'Runner',
				passwordHash: 'x',
			},
			select: { id: true },
		});
		creatorId = u.id;
	}
	const lead = await prisma.lead.create({ data: { firstName: `${TAG}-l` } });
	const client = await prisma.client.create({
		data: { firstName: `${TAG}-c` },
	});
	const cr = await prisma.clientRequest.findFirst({ select: { id: true } });
	leadId = lead.id;
	clientId = client.id;
	crId = cr?.id ?? null;
});

afterAll(async () => {
	if (createdCallIds.length > 0) {
		await prisma.clientCall.deleteMany({
			where: { id: { in: createdCallIds } },
		});
	}
	await prisma.lead.delete({ where: { id: leadId } }).catch(() => undefined);
	await prisma.client
		.delete({ where: { id: clientId } })
		.catch(() => undefined);
	await prisma.$disconnect();
});

// scheduledAt must be at least 30 minutes in the future per the
// new validation rule — use a 2-hour horizon from "now" so a slow
// CI run still passes the check.
const base = () => ({
	callTitle: 'Confidential strategy call',
	scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
	clientTimezone: 'Europe/Kyiv',
	duration: 45,
});

describe('ClientCall activity emission', () => {
	it('emits lead.call_created on a Lead-owned call and omits sensitive body', async () => {
		recorded.length = 0;
		const call = await svc.create(
			{
				...base(),
				clientType: ClientCallClientType.lead,
				leadId,
			} as unknown as CreateClientCallDto,
			creatorId,
		);
		createdCallIds.push(call.id);
		const evt = recorded.find((r) => r.action === 'lead.call_created');
		expect(evt).toBeDefined();
		expect(evt?.targetType).toBe('Lead');
		expect(evt?.targetId).toBe(leadId);
		// Only callId + scheduledAt in metadata — never the call title
		// or notes.
		const metaStr = JSON.stringify(evt?.metadata ?? {});
		expect(metaStr).toContain('callId');
		expect(metaStr).not.toContain('Confidential');
	});

	it('emits client.call_created on a Client-owned call', async () => {
		recorded.length = 0;
		const call = await svc.create(
			{
				...base(),
				clientType: ClientCallClientType.client,
				crmClientId: clientId,
			} as unknown as CreateClientCallDto,
			creatorId,
		);
		createdCallIds.push(call.id);
		const evt = recorded.find((r) => r.action === 'client.call_created');
		expect(evt).toBeDefined();
		expect(evt?.targetType).toBe('Client');
		expect(evt?.targetId).toBe(clientId);
	});

	it('rejects a new call owned by a Website Request (Sales rework forbids this path)', async () => {
		if (!crId) {
			// No ClientRequest in local DB — nothing to try against.
			return;
		}
		await expect(
			svc.create(
				{
					...base(),
					clientType: ClientCallClientType.client_request,
					clientRequestId: crId,
				} as unknown as CreateClientCallDto,
				creatorId,
			),
		).rejects.toThrow(/Website Request is no longer a supported owner/);
	});
});
