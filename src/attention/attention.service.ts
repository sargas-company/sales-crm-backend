import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import {
	AttentionItem,
	AttentionResponse,
} from './attention.types';

/**
 * Builds the owner-facing "attention panel". Everything here is a
 * derived signal computed on-demand from current state — no new
 * table, nothing to clean up. Rules deliberately stay actionable:
 * if a human doesn't need to do anything, we don't emit a row.
 */
@Injectable()
export class AttentionService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly settings: SettingsService,
	) {}

	async getItems(): Promise<AttentionResponse> {
		const items: AttentionItem[] = [];
		const now = Date.now();

		// ─── System: Scanner paused ────────────────────────────────
		const scannerOn = await this.settings.getBooleanForKey(
			SK.SCANNER_INGESTION_ENABLED,
			true,
		);
		if (!scannerOn) {
			items.push({
				id: 'scanner.paused',
				severity: 'warn',
				category: 'system',
				title: 'Scanner ingestion is paused',
				description:
					'New job posts are not being accepted. Re-enable in Scanner settings.',
				action: {
					route: '/settings?s=scanner_alerts',
					label: 'Open scanner settings',
				},
				createdAt: new Date().toISOString(),
			});
		}

		// ─── System: Vibe Worker silence ────────────────────────────
		const lastIngest = await this.prisma.jobPostIngestEvent.findFirst({
			orderBy: { receivedAt: 'desc' },
			select: { receivedAt: true },
		});
		if (lastIngest) {
			const ageMs = now - lastIngest.receivedAt.getTime();
			const ageHours = ageMs / (1000 * 60 * 60);
			if (ageHours > 24) {
				items.push({
					id: 'vibe.silent.critical',
					severity: 'critical',
					category: 'system',
					title: 'Vibe Worker silent for over 24 hours',
					description: `Last webhook event was ${this.formatRelative(ageMs)}. The upstream may be broken.`,
					action: {
						route: '/settings?s=integrations',
						label: 'Open integrations',
					},
					createdAt: lastIngest.receivedAt.toISOString(),
				});
			} else if (ageHours > 6) {
				items.push({
					id: 'vibe.silent.warn',
					severity: 'warn',
					category: 'system',
					title: 'Vibe Worker has been quiet',
					description: `Last webhook event was ${this.formatRelative(ageMs)}. Check if the upstream is still delivering.`,
					action: {
						route: '/settings?s=integrations',
						label: 'Open integrations',
					},
					createdAt: lastIngest.receivedAt.toISOString(),
				});
			}
		}

		// ─── System: Backups late or failed ────────────────────────
		const lastBackup = await this.prisma.backupRun.findFirst({
			orderBy: { startedAt: 'desc' },
			select: { startedAt: true, status: true, errorMessage: true },
		});
		if (!lastBackup) {
			items.push({
				id: 'backup.none',
				severity: 'critical',
				category: 'system',
				title: 'No backup has ever run',
				description:
					'The scheduler has never produced a backup. Check the schedule and credentials.',
				action: { route: '/backups/list', label: 'Open backups' },
				createdAt: new Date().toISOString(),
			});
		} else {
			const ageMs = now - lastBackup.startedAt.getTime();
			const ageHours = ageMs / (1000 * 60 * 60);
			if (lastBackup.status === 'FAILED') {
				items.push({
					id: 'backup.lastFailed',
					severity: 'critical',
					category: 'system',
					title: 'Last backup failed',
					description:
						lastBackup.errorMessage ??
						'The most recent backup finished with an error.',
					action: { route: '/backups/list', label: 'Open backups' },
					createdAt: lastBackup.startedAt.toISOString(),
				});
			} else if (ageHours > 168) {
				items.push({
					id: 'backup.staleWeek',
					severity: 'critical',
					category: 'system',
					title: 'No successful backup for over a week',
					description: `Last successful backup was ${this.formatRelative(ageMs)}.`,
					action: { route: '/backups/list', label: 'Open backups' },
					createdAt: lastBackup.startedAt.toISOString(),
				});
			} else if (ageHours > 48) {
				items.push({
					id: 'backup.stale2days',
					severity: 'warn',
					category: 'system',
					title: 'Backup is behind schedule',
					description: `Last successful backup was ${this.formatRelative(ageMs)}.`,
					action: { route: '/backups/list', label: 'Open backups' },
					createdAt: lastBackup.startedAt.toISOString(),
				});
			}
		}

		// ─── Business: High-score job posts waiting ─────────────────
		const highScoreCutoff = new Date(now - 24 * 60 * 60 * 1000);
		const highScorePending = await this.prisma.jobPost.count({
			where: {
				matchScore: { gte: 90 },
				decision: null,
				createdAt: { lte: highScoreCutoff },
			},
		});
		if (highScorePending > 0) {
			items.push({
				id: 'business.highScoreWaiting',
				severity: highScorePending >= 5 ? 'warn' : 'info',
				category: 'business',
				title: `${highScorePending} high-score job post${highScorePending === 1 ? '' : 's'} waiting review`,
				description:
					'Scored at 90%+ and sitting for more than 24h without a decision.',
				action: {
					route: '/job-posts/list',
					label: 'Review job posts',
				},
				createdAt: highScoreCutoff.toISOString(),
			});
		}

		// Sort by severity (critical first), then by createdAt (newest first).
		const sevRank: Record<string, number> = { critical: 0, warn: 1, info: 2 };
		items.sort((a, b) => {
			const s = sevRank[a.severity] - sevRank[b.severity];
			if (s !== 0) return s;
			return (
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
			);
		});

		return { items };
	}

	private formatRelative(ms: number): string {
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s} seconds ago`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
		const d = Math.round(h / 24);
		return `${d} day${d === 1 ? '' : 's'} ago`;
	}
}
