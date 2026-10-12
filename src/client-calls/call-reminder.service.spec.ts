import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import {
  CallReminderType,
  ClientCallClientType,
  ClientCallStatus,
  PrismaClient,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { CallReminderService } from './call-reminder.service';

/* Behavioural contract for the reminder cron:
 *   - the two live windows (min60 at [now+50, now+65],
 *     min10 at [now, now+15]) fire exactly once per (call, type);
 *   - the catch-up window picks up a call whose target was in the
 *     previous tick, but only when the lead-time guard allows;
 *   - the 1h / 10m reminders don't fire for calls created or
 *     rescheduled already closer than that threshold to their own
 *     scheduledAt (`anchorAt + threshold > scheduledAt` short-circuit);
 *   - calls whose scheduledAt has passed are never reminded;
 *   - a poisonous legacy timezone falls back to UTC and does not
 *     poison its neighbours;
 *   - dedup rows are rolled back when the notification side fails,
 *     so the next tick can retry exactly once.
 *
 * Needs a confirmed local test database (see sales-crm-backend/CLAUDE.md).
 */

const prisma = new PrismaClient();

type RecordedEvent = { type: string; payload: Record<string, unknown> };
let recorded: RecordedEvent[];
let createEventShouldThrow: Error | null;
const notifications = {
	createEvent: async (type: string, payload: Record<string, unknown>) => {
		if (createEventShouldThrow) {
			const err = createEventShouldThrow;
			// Only throw once per arm so a retry on the next tick lands.
			createEventShouldThrow = null;
			throw err;
		}
		recorded.push({ type, payload });
	},
} as unknown as NotificationService;

const svc = new CallReminderService(
	prisma as unknown as PrismaService,
	notifications,
);
const runTick = (): Promise<void> =>
	(svc as unknown as { tick: () => Promise<void> }).tick();

const TAG = `cc-rem-${randomUUID().slice(0, 8)}`;
let creatorId: string;
let leadId: string;
const callIds: string[] = [];

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
	leadId = lead.id;
});

beforeEach(() => {
	recorded = [];
	createEventShouldThrow = null;
});

afterAll(async () => {
	if (callIds.length > 0) {
		// Delete reminder stamps first, then calls (cascade also covers it).
		await prisma.callReminderSent.deleteMany({ where: { callId: { in: callIds } } });
		await prisma.clientCall.deleteMany({ where: { id: { in: callIds } } });
	}
	await prisma.lead.delete({ where: { id: leadId } }).catch(() => undefined);
	await prisma.$disconnect();
});

type MakeCallInput = {
	scheduledAtMs: number;
	timezone?: string;
	status?: ClientCallStatus;
	// Simulated moments. Prisma's defaults would otherwise pin
	// `createdAt` to now; our 1h-anchor guard needs to see a different
	// value to prove it works.
	createdAtMs?: number;
	rescheduledAtMs?: number | null;
};

async function makeCall(opts: MakeCallInput): Promise<string> {
	const row = await prisma.clientCall.create({
		data: {
			clientType: ClientCallClientType.lead,
			leadId,
			createdById: creatorId,
			callTitle: `${TAG}-${randomUUID().slice(0, 4)}`,
			scheduledAt: new Date(opts.scheduledAtMs),
			clientTimezone: opts.timezone ?? 'Europe/Kyiv',
			duration: 30,
			status: opts.status ?? ClientCallStatus.scheduled,
			...(opts.createdAtMs !== undefined
				? { createdAt: new Date(opts.createdAtMs) }
				: {}),
			...(opts.rescheduledAtMs !== undefined && opts.rescheduledAtMs !== null
				? { rescheduledAt: new Date(opts.rescheduledAtMs) }
				: {}),
		},
		select: { id: true },
	});
	callIds.push(row.id);
	return row.id;
}

const MIN = 60_000;

describe('CallReminderService — windows and dedup', () => {
	it('fires min60 for a call ~62 min ahead with enough lead-time at creation', async () => {
		const now = Date.now();
		const id = await makeCall({
			scheduledAtMs: now + 62 * MIN,
			// Plenty of lead-time at creation (>= 60 min).
			createdAtMs: now - 10 * MIN,
		});
		await runTick();
		const myEvents = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		const types = myEvents.map((e) => (e.payload as { reminderType: string }).reminderType);
		expect(types).toContain('60min');
	});

	it('fires min10 for a call ~12 min ahead', async () => {
		const now = Date.now();
		const id = await makeCall({
			scheduledAtMs: now + 12 * MIN,
			createdAtMs: now - 5 * MIN,
		});
		await runTick();
		const myEvents = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		const types = myEvents.map((e) => (e.payload as { reminderType: string }).reminderType);
		expect(types).toContain('10min');
	});

	it('dedup: same tick twice emits one event per threshold', async () => {
		const now = Date.now();
		const id = await makeCall({
			scheduledAtMs: now + 62 * MIN,
			createdAtMs: now - 10 * MIN,
		});
		await runTick();
		await runTick();
		const myEvents = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		expect(myEvents).toHaveLength(1);
		const stamps = await prisma.callReminderSent.findMany({ where: { callId: id } });
		expect(stamps).toHaveLength(1);
	});

	it('catch-up: picks up a call whose target was in the previous tick', async () => {
		const now = Date.now();
		// scheduledAt = now + 52 min → min60 target was 8 min ago, so
		// standard forward window would miss it. Catch-up (10 min) picks
		// it up — but only because the lead-time guard allows it.
		const id = await makeCall({
			scheduledAtMs: now + 52 * MIN,
			createdAtMs: now - 15 * MIN, // created 15 min ago => leadTime at anchor = 67 min >= 60.
		});
		await runTick();
		const myEvents = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		const types = myEvents.map((e) => (e.payload as { reminderType: string }).reminderType);
		expect(types).toContain('60min');
	});

	it('no min60 when the call was created already closer than 60 min to its time', async () => {
		const now = Date.now();
		const id = await makeCall({
			scheduledAtMs: now + 55 * MIN,
			createdAtMs: now - 1 * MIN, // leadTime at anchor = 56 min < 60.
		});
		await runTick();
		const myEvents = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		const types = myEvents.map((e) => (e.payload as { reminderType: string }).reminderType);
		expect(types).not.toContain('60min');
	});

	it('no min60 when the call was rescheduled closer than 60 min to its time', async () => {
		const now = Date.now();
		const id = await makeCall({
			scheduledAtMs: now + 55 * MIN,
			createdAtMs: now - 10 * 60 * MIN, // created long ago (would otherwise satisfy guard)
			rescheduledAtMs: now - 2 * MIN,    // but rescheduled just now
		});
		await runTick();
		const myEvents = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		const types = myEvents.map((e) => (e.payload as { reminderType: string }).reminderType);
		expect(types).not.toContain('60min');
	});

	it('no reminder after the call has started', async () => {
		const now = Date.now();
		// scheduledAt in the past, but still status=scheduled (nothing
		// has moved it to completed/cancelled).
		const id = await makeCall({
			scheduledAtMs: now - 2 * MIN,
			createdAtMs: now - 2 * 60 * MIN,
		});
		await runTick();
		const myEvents = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		expect(myEvents).toHaveLength(0);
	});

	it('cancelled calls never trigger reminders', async () => {
		const now = Date.now();
		const id = await makeCall({
			scheduledAtMs: now + 12 * MIN,
			createdAtMs: now - 5 * MIN,
			status: ClientCallStatus.cancelled,
		});
		await runTick();
		const myEvents = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		expect(myEvents).toHaveLength(0);
	});

	it('invalid legacy timezone falls back to UTC and does not block neighbours', async () => {
		const now = Date.now();
		const poisonId = await makeCall({
			scheduledAtMs: now + 62 * MIN,
			timezone: '+2', // RangeError in Intl without the fallback
			createdAtMs: now - 10 * MIN,
		});
		const neighbourId = await makeCall({
			scheduledAtMs: now + 63 * MIN,
			createdAtMs: now - 10 * MIN,
		});
		await runTick();
		const poison = recorded.find(
			(e) => (e.payload as { callId: string }).callId === poisonId,
		);
		const neighbour = recorded.find(
			(e) => (e.payload as { callId: string }).callId === neighbourId,
		);
		// Poison call still fired (UTC fallback kicked in).
		expect(poison).toBeDefined();
		// Neighbour wasn't swallowed by the poison call's would-be throw.
		expect(neighbour).toBeDefined();
	});

	it('rolls back the dedup stamp when createEvent fails, allowing retry', async () => {
		const now = Date.now();
		const id = await makeCall({
			scheduledAtMs: now + 62 * MIN,
			createdAtMs: now - 10 * MIN,
		});

		// First tick: simulate createEvent failure. The service must
		// clean the stamp so the next tick can retry.
		createEventShouldThrow = new Error('simulated queue outage');
		await runTick();
		const stampsAfterFirst = await prisma.callReminderSent.findMany({
			where: { callId: id, type: CallReminderType.min60 },
		});
		expect(stampsAfterFirst).toHaveLength(0);
		const eventsAfterFirst = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		expect(eventsAfterFirst).toHaveLength(0);

		// Second tick: no simulated throw -> event fires exactly once.
		await runTick();
		const eventsAfterSecond = recorded.filter(
			(e) => (e.payload as { callId: string }).callId === id,
		);
		expect(
			eventsAfterSecond.filter(
				(e) => (e.payload as { reminderType: string }).reminderType === '60min',
			),
		).toHaveLength(1);
		const stampsAfterSecond = await prisma.callReminderSent.findMany({
			where: { callId: id, type: CallReminderType.min60 },
		});
		expect(stampsAfterSecond).toHaveLength(1);
	});
});
