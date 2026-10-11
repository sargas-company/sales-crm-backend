import { describe, it, expect, jest } from '@jest/globals';
import { DiscordProfile } from '@prisma/client';

import { DiscordSchedulersService } from './discord-schedulers.service';

/* Targeted unit test for `runReminder` weekend behaviour.
 *
 * Product decision: the 18:00 reminder is a weekday-only courtesy.
 * On Saturday / Sunday it must NOT post, even when manager role,
 * channel and reports-url are all configured. The old "ping anyway
 * if a project is below 40h this week" branch is gone.
 *
 * runReminder is private → accessed via `(svc as any)` here. The
 * spec stubs only what runReminder actually touches:
 *   - `currentDow(profile.timezone)` is spied to return the day.
 *   - `this.bot.postMessage` records the call count.
 *   - `this.reportsUrl()` is spied to return a stable string.
 */

const stubProfile = (overrides: Partial<DiscordProfile> = {}): DiscordProfile =>
	({
		id: 'p-1',
		name: 'TEST',
		active: true,
		timezone: 'Europe/Kyiv',
		pmsChannelId: '123456789012345678',
		managerRoleId: '999000111222333444',
		reportsEnabled: true,
		reminderAt: '18:00',
		dailyDigestAt: '19:00',
		weeklyEnabled: false,
		...overrides,
	}) as unknown as DiscordProfile;

const makeSvc = (opts: {
	dow: number;
	postResp?: { ok: boolean; status?: number; message?: string };
}) => {
	const postMessage = jest.fn(async () =>
		opts.postResp ?? { ok: true, messageId: 'm-1' },
	);
	const bot = { postMessage } as any;
	const embeds = {
		reminderContent: (role: string | null, url: string) =>
			role ? `<@&${role}>, please fill the daily reports. ${url}` : `${url}`,
	} as any;
	const svc = new DiscordSchedulersService(
		{} as any,
		bot,
		embeds,
		{} as any,
		{} as any,
	);
	jest.spyOn(svc as any, 'currentDow').mockReturnValue(opts.dow);
	jest
		.spyOn(svc as any, 'reportsUrl')
		.mockReturnValue('https://admin.example.com/projects/reports');
	return { svc, postMessage };
};

describe('DiscordSchedulersService.runReminder — weekend policy', () => {
	it('Saturday (dow=6) → does NOT post', async () => {
		const { svc, postMessage } = makeSvc({ dow: 6 });
		await (svc as any).runReminder(stubProfile());
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('Sunday (dow=0) → does NOT post', async () => {
		const { svc, postMessage } = makeSvc({ dow: 0 });
		await (svc as any).runReminder(stubProfile());
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('Monday (dow=1) → posts the reminder', async () => {
		const { svc, postMessage } = makeSvc({ dow: 1 });
		await (svc as any).runReminder(stubProfile());
		expect(postMessage).toHaveBeenCalledTimes(1);
		const call = (postMessage.mock.calls as unknown as Array<
			[{
				channelId: string;
				content: string;
				allowedMentions: { parse: string[]; roles?: string[] };
			}]
		>)[0]![0];
		expect(call.channelId).toBe('123456789012345678');
		expect(call.content).toContain('please fill the daily reports');
		expect(call.allowedMentions.parse).toEqual([]);
		expect(call.allowedMentions.roles).toEqual(['999000111222333444']);
	});

	it('Friday (dow=5) → posts', async () => {
		const { svc, postMessage } = makeSvc({ dow: 5 });
		await (svc as any).runReminder(stubProfile());
		expect(postMessage).toHaveBeenCalledTimes(1);
	});

	it('weekend policy applies even when managerRoleId is null (no silent ping)', async () => {
		const { svc, postMessage } = makeSvc({ dow: 0 });
		await (svc as any).runReminder(stubProfile({ managerRoleId: null }));
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('throws when pmsChannelId is missing (regardless of dow)', async () => {
		const { svc } = makeSvc({ dow: 1 });
		await expect(
			(svc as any).runReminder(stubProfile({ pmsChannelId: null })),
		).rejects.toThrow('pmsChannelId missing');
	});
});
