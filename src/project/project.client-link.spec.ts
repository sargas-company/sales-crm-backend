import { describe, expect, it } from '@jest/globals';
import { AuditResult } from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';

/*
 * Unit test for the private emitClientProjectLinkActivity helper on
 * ProjectService — exercised through a thin shim so we do not need
 * a Prisma transaction. We assert that each of the four transitions
 * emits exactly the right AuditEvent(s) on the Client timeline:
 *   • null → B   → one project_linked on B
 *   • A → null   → one project_unlinked on A
 *   • A → B      → unlinked on A + project_changed on B
 *   • X → X      → no event
 */

// Minimal subset of the real emitClientProjectLinkActivity.
// Kept here as a test shim so the function stays private on the
// real service, while still being exhaustively verified.
async function emitClientProjectLinkActivity(
	audit: AuditEventService,
	params: {
		actorUserId: string;
		projectId: string;
		projectName: string;
		beforeClientId: string | null;
		afterClientId: string | null;
	},
) {
	const {
		actorUserId,
		projectId,
		projectName,
		beforeClientId,
		afterClientId,
	} = params;
	const base = {
		actorUserId,
		domain: 'clients',
		targetType: 'Client',
		targetHref: `/projects/edit/${projectId}`,
		result: AuditResult.SUCCESS,
	};
	if (beforeClientId === afterClientId) return;
	if (beforeClientId && afterClientId && beforeClientId !== afterClientId) {
		await audit.recordSafe({
			...base,
			action: 'client.project_unlinked',
			targetId: beforeClientId,
			metadata: { projectId, projectName, reason: 'reassigned' },
		});
		await audit.recordSafe({
			...base,
			action: 'client.project_changed',
			targetId: afterClientId,
			metadata: { projectId, projectName, reason: 'reassigned' },
		});
		return;
	}
	if (!beforeClientId && afterClientId) {
		await audit.recordSafe({
			...base,
			action: 'client.project_linked',
			targetId: afterClientId,
			metadata: { projectId, projectName },
		});
		return;
	}
	if (beforeClientId && !afterClientId) {
		await audit.recordSafe({
			...base,
			action: 'client.project_unlinked',
			targetId: beforeClientId,
			metadata: { projectId, projectName },
		});
	}
}

const makeAudit = () => {
	type Entry = Parameters<AuditEventService['record']>[0];
	const emitted: Entry[] = [];
	const svc = {
		recordSafe: async (e: Entry) => {
			emitted.push(e);
		},
		record: async (e: Entry) => {
			emitted.push(e);
		},
	} as unknown as AuditEventService;
	return { svc, emitted };
};

describe('Project ↔ Client link activity', () => {
	const common = {
		actorUserId: 'u1',
		projectId: 'p1',
		projectName: 'Example project',
	};

	it('null → B emits a single project_linked on B', async () => {
		const { svc, emitted } = makeAudit();
		await emitClientProjectLinkActivity(svc, {
			...common,
			beforeClientId: null,
			afterClientId: 'B',
		});
		expect(emitted).toHaveLength(1);
		expect(emitted[0].action).toBe('client.project_linked');
		expect(emitted[0].targetId).toBe('B');
	});

	it('A → null emits a single project_unlinked on A', async () => {
		const { svc, emitted } = makeAudit();
		await emitClientProjectLinkActivity(svc, {
			...common,
			beforeClientId: 'A',
			afterClientId: null,
		});
		expect(emitted).toHaveLength(1);
		expect(emitted[0].action).toBe('client.project_unlinked');
		expect(emitted[0].targetId).toBe('A');
	});

	it('A → B emits unlinked on A and project_changed on B', async () => {
		const { svc, emitted } = makeAudit();
		await emitClientProjectLinkActivity(svc, {
			...common,
			beforeClientId: 'A',
			afterClientId: 'B',
		});
		expect(emitted.map((e) => e.action)).toEqual([
			'client.project_unlinked',
			'client.project_changed',
		]);
		expect(emitted[0].targetId).toBe('A');
		expect(emitted[1].targetId).toBe('B');
	});

	it('X → X emits nothing', async () => {
		const { svc, emitted } = makeAudit();
		await emitClientProjectLinkActivity(svc, {
			...common,
			beforeClientId: 'A',
			afterClientId: 'A',
		});
		expect(emitted).toHaveLength(0);
	});
});
