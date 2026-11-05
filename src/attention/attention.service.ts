import { Injectable } from '@nestjs/common';
import { PayrollStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import { UpworkRemindersService } from '../upwork/upwork-reminders.service';
import {
	AttentionItem,
	AttentionResponse,
} from './attention.types';

const MONTH_NAMES = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December',
] as const;

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
		private readonly upworkReminders: UpworkRemindersService,
	) {}

	async getItems(callerPerms: Set<string> = new Set()): Promise<AttentionResponse> {
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

		// ─── Business: Unpaid payroll for the previous calendar month
		//   Owner-only (`salaries:view` is granted to Owner by preset).
		//   Fires while any PayrollEntry for the previous (year, month)
		//   is still in DRAFT. One aggregate row; clears automatically
		//   when every entry flips to PAID.
		if (callerPerms.has('salaries:view')) {
			const anchor = new Date();
			anchor.setUTCDate(1);
			anchor.setUTCMonth(anchor.getUTCMonth() - 1);
			const prevYear = anchor.getUTCFullYear();
			const prevMonth = anchor.getUTCMonth() + 1;
			const unpaid = await this.prisma.payrollEntry.count({
				where: {
					year: prevYear,
					month: prevMonth,
					status: PayrollStatus.DRAFT,
				},
			});
			if (unpaid > 0) {
				const monthLabel = `${MONTH_NAMES[prevMonth - 1]} ${prevYear}`;
				items.push({
					id: 'payroll.unpaidPrevMonth',
					severity: unpaid >= 3 ? 'critical' : 'warn',
					category: 'business',
					title: `${unpaid} unpaid salar${unpaid === 1 ? 'y' : 'ies'} for ${monthLabel}`,
					description:
						'Open Monthly Run and mark them paid once the wires have gone out.',
					action: {
						route: `/finances/salaries/run?year=${prevYear}&month=${prevMonth}`,
						label: 'Open Monthly Run',
					},
					createdAt: new Date().toISOString(),
				});
			}
		}

		// ─── Business: Unreceived payments in closed fiscal months
		//   Owner-only (`finances_weekly:view` is Owner-only by preset).
		//   For every FiscalMonth whose endDate has passed, count
		//   WeeklyEntry rows still in `in_transit` or `planned_invoice`
		//   (per the owner's rule: `received` / `no_work` /
		//   `expected_later` / `expected_this_month` are silent). One
		//   row per such month; auto-clears when the statuses flip to
		//   `received`. Cap at 12 to avoid a historical tail exploding
		//   the panel if something is left stuck way back.
		if (callerPerms.has('finances_weekly:view')) {
			const today = new Date();
			today.setUTCHours(0, 0, 0, 0);
			const closedMonths = await this.prisma.fiscalMonth.findMany({
				where: { endDate: { lt: today } },
				orderBy: { endDate: 'desc' },
				take: 12,
				select: { id: true, label: true, endDate: true },
			});
			for (const fm of closedMonths) {
				const overdue = await this.prisma.weeklyEntry.count({
					where: {
						fiscalWeek: { fiscalMonthId: fm.id },
						status: {
							in: [PaymentStatus.in_transit, PaymentStatus.planned_invoice],
						},
					},
				});
				if (overdue > 0) {
					items.push({
						id: `payments.unreceived.${fm.id}`,
						severity: overdue >= 3 ? 'critical' : 'warn',
						category: 'business',
						title: `${overdue} unreceived payment${overdue === 1 ? '' : 's'} in ${fm.label}`,
						description:
							'Flip each entry to Received once the money lands.',
						action: {
							route: `/finances/payments/month/${fm.id}`,
							label: 'Open month',
						},
						createdAt: fm.endDate.toISOString(),
					});
				}
			}
		}

		// ─── Business: Upwork reminders waiting ─────────────────────
		//   Attention panel dedupes to a single aggregated row —
		//   details live on /upwork/reminders. Auto-disappears when
		//   the owner clears everything. Upwork is owner-only, so
		//   non-owners (admin_manager with notifications:view but
		//   without upwork:view) get no item and no dead-end link.
		if (callerPerms.has('upwork:view')) {
			const upworkSummary = await this.upworkReminders.summary();
			if (upworkSummary.profiles > 0) {
				const { profiles, totalReminders } = upworkSummary;
				items.push({
					id: 'upwork.remindersWaiting',
					severity:
						totalReminders >= 10
							? 'critical'
							: totalReminders >= 5
								? 'warn'
								: 'info',
					category: 'business',
					title: `${profiles} Upwork profile${profiles === 1 ? '' : 's'} need${profiles === 1 ? 's' : ''} attention`,
					description: `${totalReminders} reminder${totalReminders === 1 ? '' : 's'} across ${profiles} profile${profiles === 1 ? '' : 's'}. Open to see which sections and snapshots are overdue.`,
					action: {
						route: '/upwork/reminders',
						label: 'Open reminders',
					},
					createdAt: new Date().toISOString(),
				});
			}
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
