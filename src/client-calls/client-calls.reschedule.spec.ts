import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import {
	CallReminderType,
	ClientCallClientType,
	ClientCallStatus,
	PrismaClient,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { NotificationService } from '../notification/notification.service';
import { ClientCallsService } from './client-calls.service';
import type { CreateClientCallDto } from './dto/create-client-call.dto';

/* Verifies the PATCH path keeps three invariants:
 *   - a real `scheduledAt` change moves `rescheduledAt`, purges
 *     existing `CallReminderSent` stamps, and emits one
 *     `CALL_RESCHEDULED` event — all in one atomic motion;
 *   - a notes- / title- / status-only PATCH never touches
 *     `rescheduledAt`, never purges stamps, and never emits a
 *     reschedule event;
 *   - a transition into `cancelled` emits exactly one
 *     `CALL_CANCELLED` event and does not purge stamps.
 *
 * Needs a confirmed local test database (see sales-crm-backend/CLAUDE.md).
 */

const prisma = new PrismaClient();

type RecordedEvent = { type: string; payload: Record<string, unknown> };
let events: RecordedEvent[] = [];
const notificationsStub = {
	createEvent: async (type: string, payload: Record<string, unknown>) => {
		events.push({ type, payload });
	},
} as unknown as NotificationService;
const auditStub = {
	recordSafe: async () => undefined,
	record: async () => undefined,
} as unknown as AuditEventService;

const svc = new ClientCallsService(
	prisma as unknown as PrismaService,
	auditStub,
	notificationsStub,
);

const TAG = `cc-resched-${randomUUID().slice(0, 8)}`;
let creatorId: string;
let leadId: string;
const callIds: string[] = [];

const future = (minutes: number): string =>
	new Date(Date.now() + minutes * 60_000).toISOString();

beforeAll(async () => {
	const u = await prisma.user.findFirst({ select: { id: true } });
	creatorId = u
		? u.id
		: (
				await prisma.user.create({
					data: {
						email: `${TAG}@test.local`,
						firstName: 'Spec',
						lastName: 'Runner',
						passwordHash: 'x',
					},
					select: { id: true },
				})
			).id;
	const lead = await prisma.lead.create({ data: { firstName: `${TAG}-l` } });
	leadId = lead.id;
});

beforeEach(() => {
	events = [];
});

afterAll(async () => {
	if (callIds.length > 0) {
		await prisma.callReminderSent.deleteMany({ where: { callId: { in: callIds } } });
		await prisma.clientCall.deleteMany({ where: { id: { in: callIds } } });
	}
	await prisma.lead.delete({ where: { id: leadId } }).catch(() => undefined);
	await prisma.$disconnect();
});

async function makeCall(scheduledMinAhead: number): Promise<string> {
	const call = await svc.create(
		{
			clientType: ClientCallClientType.lead,
			leadId,
			callTitle: `${TAG}-${randomUUID().slice(0, 4)}`,
			scheduledAt: future(scheduledMinAhead),
			clientTimezone: 'Europe/Kyiv',
			duration: 30,
		} as unknown as CreateClientCallDto,
		creatorId,
	);
	callIds.push(call.id);
	return call.id;
}

describe('ClientCall update — reschedule vs notes-only', () => {
	it('real scheduledAt change: sets rescheduledAt, purges stamps, emits CALL_RESCHEDULED', async () => {
		const id = await makeCall(120);
		// Seed a stamp as if the cron had already fired for this call.
		await prisma.callReminderSent.create({
			data: { callId: id, type: CallReminderType.min60 },
		});

		// Clear the create-time events; we only care about the reschedule event here.
		events = [];

		await svc.update(id, { scheduledAt: future(150) });

		const after = await prisma.clientCall.findUnique({ where: { id } });
		expect(after?.rescheduledAt).not.toBeNull();
		const stamps = await prisma.callReminderSent.findMany({ where: { callId: id } });
		expect(stamps).toHaveLength(0);
		const resched = events.filter((e) => e.type === 'CALL_RESCHEDULED');
		expect(resched).toHaveLength(1);
	});

	it('notes-only PATCH: does not touch rescheduledAt, does not purge stamps, does not emit', async () => {
		const id = await makeCall(120);
		await prisma.callReminderSent.create({
			data: { callId: id, type: CallReminderType.min60 },
		});
		const before = await prisma.clientCall.findUnique({ where: { id } });

		events = [];
		await svc.update(id, { notes: 'added notes only, no time change' });

		const after = await prisma.clientCall.findUnique({ where: { id } });
		expect(after?.rescheduledAt).toEqual(before?.rescheduledAt);
		expect(after?.scheduledAt?.getTime()).toEqual(before?.scheduledAt?.getTime());
		const stamps = await prisma.callReminderSent.findMany({ where: { callId: id } });
		expect(stamps).toHaveLength(1);
		const resched = events.filter((e) => e.type === 'CALL_RESCHEDULED');
		expect(resched).toHaveLength(0);
	});

	it('resubmitting the same scheduledAt is NOT a reschedule', async () => {
		const id = await makeCall(120);
		const row = await prisma.clientCall.findUnique({ where: { id } });
		events = [];

		await svc.update(id, {
			scheduledAt: row!.scheduledAt.toISOString(),
			callTitle: 'edited title only',
		});

		const after = await prisma.clientCall.findUnique({ where: { id } });
		// Same instant → not a reschedule, so rescheduledAt stays null.
		expect(after?.rescheduledAt).toBeNull();
		const resched = events.filter((e) => e.type === 'CALL_RESCHEDULED');
		expect(resched).toHaveLength(0);
	});

	it('transition into cancelled emits CALL_CANCELLED and leaves stamps alone', async () => {
		const id = await makeCall(120);
		await prisma.callReminderSent.create({
			data: { callId: id, type: CallReminderType.min10 },
		});

		events = [];
		await svc.update(id, { status: ClientCallStatus.cancelled });

		const stamps = await prisma.callReminderSent.findMany({ where: { callId: id } });
		expect(stamps).toHaveLength(1);
		const cancelled = events.filter((e) => e.type === 'CALL_CANCELLED');
		expect(cancelled).toHaveLength(1);
	});
});
