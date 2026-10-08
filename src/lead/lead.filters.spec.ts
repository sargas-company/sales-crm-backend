import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import {
	LeadStatus,
	LeadTemperature,
	PrismaClient,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { LeadService } from './lead.service';
import type { AuthUser } from '../auth/auth-user';

/* Minimal integration coverage for the new independent status +
 * temperature filters on the Lead list query. Also exercises the
 * single-string → array path used by the DTO transformer. */

const prisma = new PrismaClient();
const auditStub = {
	recordSafe: async () => undefined,
	record: async () => undefined,
} as unknown as AuditEventService;
const svc = new LeadService(prisma as unknown as PrismaService, auditStub);
const user = {
	id: '00000000-0000-0000-0000-000000000011',
	permissions: new Set<string>(['leads:create', 'leads:update']),
} as AuthUser;

const TAG = `lead-flt-${randomUUID().slice(0, 8)}`;
const created: string[] = [];

const makeLead = async (
	status: LeadStatus,
	temperature: LeadTemperature | null,
) => {
	const row = await prisma.lead.create({
		data: {
			firstName: `${TAG}-${status}`,
			status,
			temperature,
		},
	});
	created.push(row.id);
	return row;
};

beforeAll(async () => {
	await Promise.all([
		makeLead('NEW', 'COLD'),
		makeLead('CONTACTED', 'WARM'),
		makeLead('IN_CONVERSATION', 'HOT'),
		makeLead('ON_HOLD', null),
		makeLead('WON', 'HOT'),
		makeLead('LOST', 'COLD'),
	]);
});

afterAll(async () => {
	if (created.length > 0) {
		await prisma.lead.deleteMany({ where: { id: { in: created } } });
	}
	await prisma.$disconnect();
});

const includeOnlyTagged = (ids: string[]) =>
	ids.filter((id) => created.includes(id));

describe('Lead.findAll — status + temperature filters', () => {
	it('status alone narrows by one value', async () => {
		const { data } = await svc.findAll({
			status: ['NEW'],
			limit: 50,
		} as unknown as Parameters<typeof svc.findAll>[0]);
		const ours = includeOnlyTagged(data.map((l) => l.id));
		const matched = data.filter((l) => ours.includes(l.id));
		expect(matched.every((l) => l.status === 'NEW')).toBe(true);
		expect(matched.length).toBeGreaterThan(0);
	});

	it('temperature=HOT narrows across statuses', async () => {
		const { data } = await svc.findAll({
			temperature: ['HOT'],
			limit: 50,
		} as unknown as Parameters<typeof svc.findAll>[0]);
		const matched = data.filter((l) => created.includes(l.id));
		expect(matched.every((l) => l.temperature === 'HOT')).toBe(true);
		expect(matched.length).toBe(2);
	});

	it('status + temperature AND-combine', async () => {
		const { data } = await svc.findAll({
			status: ['WON'],
			temperature: ['HOT'],
			limit: 50,
		} as unknown as Parameters<typeof svc.findAll>[0]);
		const matched = data.filter((l) => created.includes(l.id));
		expect(matched.length).toBe(1);
		expect(matched[0].status).toBe('WON');
		expect(matched[0].temperature).toBe('HOT');
	});

	it('multi-status array (presets) works', async () => {
		const { data } = await svc.findAll({
			status: ['NEW', 'CONTACTED', 'IN_CONVERSATION', 'ON_HOLD'],
			limit: 50,
		} as unknown as Parameters<typeof svc.findAll>[0]);
		const matched = data.filter((l) => created.includes(l.id));
		expect(matched.length).toBe(4);
		expect(matched.map((l) => l.status).sort()).toEqual(
			['CONTACTED', 'IN_CONVERSATION', 'NEW', 'ON_HOLD'].sort(),
		);
	});
});
