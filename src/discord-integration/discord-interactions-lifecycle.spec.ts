/**
 * Regression tests for the /report interaction lifecycle:
 *   - success → editOriginal (ephemeral confirm) BEFORE followup (public embed);
 *   - followup lacks the `flags: 64` ephemeral flag;
 *   - public followup failure replaces the ephemeral with a warning
 *     and does NOT roll back the ProjectReport (we assert the
 *     service's create() is not called a second time);
 *   - validation / mapping errors never post a public followup;
 *   - the interaction token never appears in any log line.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';

// Signature verification is covered by its own unit tests; here we
// bypass it so the controller can exercise the lifecycle paths.
jest.mock('./ed25519', () => ({
  verifyDiscordSignature: () => true,
  isDiscordSnowflake: (v: unknown) =>
    typeof v === 'string' && /^[0-9]{17,20}$/.test(v),
}));

import { DiscordInteractionsController } from './discord-interactions.controller';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';

// A long opaque interaction token — must NEVER appear in logs.
const TOKEN =
  'aW50X3Rva2VuX3Z2JyS2VjcmV0X3BheWxvYWRfbm90X2luX2xvZ3MxMjM0NTY3ODkwYWJjZGVmZw';

type Call = { kind: 'editOriginal' | 'followup' | 'postMessage'; args: Record<string, unknown> };
type BotStub = {
  calls: Call[];
  editOriginalResponses: Array<{ ok: true; messageId: string } | { ok: false; status: number; message: string }>;
  followupResponses: Array<{ ok: true; messageId: string } | { ok: false; status: number; message: string }>;
  editOriginal: (args: Record<string, unknown>) => Promise<unknown>;
  followup: (args: Record<string, unknown>) => Promise<unknown>;
  postMessage: (args: Record<string, unknown>) => Promise<unknown>;
};

function makeBot(): BotStub {
  const stub: BotStub = {
    calls: [],
    editOriginalResponses: [{ ok: true, messageId: 'edit-1' }, { ok: true, messageId: 'edit-2' }],
    followupResponses: [{ ok: true, messageId: 'follow-1' }],
    editOriginal: jest.fn(async (args: Record<string, unknown>) => {
      stub.calls.push({ kind: 'editOriginal', args });
      return stub.editOriginalResponses.shift() ?? { ok: true, messageId: 'edit-default' };
    }) as unknown as (args: Record<string, unknown>) => Promise<unknown>,
    followup: jest.fn(async (args: Record<string, unknown>) => {
      stub.calls.push({ kind: 'followup', args });
      return stub.followupResponses.shift() ?? { ok: true, messageId: 'follow-default' };
    }) as unknown as (args: Record<string, unknown>) => Promise<unknown>,
    postMessage: jest.fn(async (args: Record<string, unknown>) => {
      stub.calls.push({ kind: 'postMessage', args });
      return { ok: true, messageId: 'post-default' };
    }) as unknown as (args: Record<string, unknown>) => Promise<unknown>,
  };
  return stub;
}

function makeReports(result: unknown | Error) {
  const createFromDiscord = jest.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { createFromDiscord } as unknown as Parameters<typeof makeController>[0];
}

function makePrisma(activeProfile: unknown) {
  return {
    discordProfile: { findFirst: async () => activeProfile },
  } as unknown as Parameters<typeof makeController>[1];
}

function makeController(reports: unknown, prisma: unknown, bot: unknown) {
  const embeds = new DiscordEmbedBuilderService();
  return new DiscordInteractionsController(
    reports as never,
    prisma as never,
    bot as never,
    embeds,
  );
}

function flushMicrotasks(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

const PROFILE = { cutoffHour: 10, timezone: 'Europe/Kyiv' };
const BASE_REPORT = {
  reportId: 'rep-1',
  projectId: 'proj-1',
  projectName: 'Discord Integration Test',
  discordUserId: '111111111111111111',
  discordUsername: 'alice',
  reportDate: new Date('2026-10-04T00:00:00Z'),
  hours: 3,
  text: 'did stuff',
  isLate: false,
  submittedAt: new Date('2026-10-04T15:00:00Z'),
};

const BASE_PAYLOAD = {
  type: 2,
  token: TOKEN,
  data: {
    name: 'report',
    options: [
      { name: 'hours', value: 3 },
      { name: 'text', value: 'did stuff' },
    ],
  },
  channel_id: '1556276365223788594',
  member: { user: { id: '111111111111111111', global_name: 'alice' } },
};

/* ─── capture logger output to assert no token leak ─── */
const loggerSpies: Array<jest.SpiedFunction<(...args: unknown[]) => void>> = [];
const loggerOutput: string[] = [];

beforeEach(() => {
  loggerOutput.length = 0;
  for (const method of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
    const spy = jest
      .spyOn(Logger.prototype, method)
      .mockImplementation(((...args: unknown[]) => {
        loggerOutput.push(args.map((a) => String(a)).join(' '));
      }) as unknown as (...args: unknown[]) => void);
    loggerSpies.push(spy);
  }
});
afterEach(() => {
  for (const s of loggerSpies) s.mockRestore();
  loggerSpies.length = 0;
});

async function invokeHandler(controller: DiscordInteractionsController, rawBody: Buffer) {
  const req = { rawBody } as never;
  return controller.handle(req, 'xx', '0');
}

describe('/report lifecycle — success path', () => {
  it('calls editOriginal (ephemeral confirm) BEFORE followup (public embed)', async () => {
    const bot = makeBot();
    const reports = makeReports(BASE_REPORT);
    const prisma = makePrisma(PROFILE);
    const ctrl = makeController(reports, prisma, bot);

    const resp = await invokeHandler(ctrl, Buffer.from(JSON.stringify(BASE_PAYLOAD), 'utf8'));
    expect(resp).toEqual({ type: 5, data: { flags: 64 } });
    await flushMicrotasks();

    const kinds = bot.calls.map((c) => c.kind);
    expect(kinds).toEqual(['editOriginal', 'followup']);
    // Confirmation payload: a content string, no flags.
    expect(bot.calls[0].args).toEqual(
      expect.objectContaining({
        interactionToken: TOKEN,
        content: expect.stringMatching(/✅ Report saved for Discord Integration Test on 2026-10-04\.$/),
      }),
    );
    // Followup carries the public embed and NO ephemeral flag.
    const followArgs = bot.calls[1].args as { embeds?: unknown[]; ephemeral?: boolean; content?: unknown };
    expect(Array.isArray(followArgs.embeds)).toBe(true);
    expect(followArgs.ephemeral).toBeUndefined();
  });

  it('appends "(marked LATE)" when result.isLate is true', async () => {
    const bot = makeBot();
    const reports = makeReports({ ...BASE_REPORT, isLate: true });
    const prisma = makePrisma(PROFILE);
    const ctrl = makeController(reports, prisma, bot);
    await invokeHandler(ctrl, Buffer.from(JSON.stringify(BASE_PAYLOAD), 'utf8'));
    await flushMicrotasks();
    expect((bot.calls[0].args as { content?: string }).content).toMatch(/marked LATE/);
  });
});

describe('/report lifecycle — public followup failure', () => {
  it('replaces ephemeral with a warning and does NOT re-create the report', async () => {
    const bot = makeBot();
    bot.followupResponses = [{ ok: false, status: 403, message: 'Missing Permissions' }];
    const reports = makeReports(BASE_REPORT);
    const prisma = makePrisma(PROFILE);
    const ctrl = makeController(reports, prisma, bot);

    await invokeHandler(ctrl, Buffer.from(JSON.stringify(BASE_PAYLOAD), 'utf8'));
    await flushMicrotasks();

    const createMock = (reports as unknown as { createFromDiscord: jest.Mock }).createFromDiscord;
    expect(createMock).toHaveBeenCalledTimes(1);

    // Expect: editOriginal(confirm) → followup(fail) → editOriginal(warning).
    const kinds = bot.calls.map((c) => c.kind);
    expect(kinds).toEqual(['editOriginal', 'followup', 'editOriginal']);
    const warn = bot.calls[2].args as { content?: string };
    expect(warn.content).toMatch(/⚠️/);
    expect(warn.content).toMatch(/public report card could not be posted/);
  });
});

describe('/report lifecycle — error branches stay ephemeral', () => {
  it('validation error does NOT call followup', async () => {
    const bot = makeBot();
    const reports = makeReports(BASE_REPORT);
    const prisma = makePrisma(PROFILE);
    const ctrl = makeController(reports, prisma, bot);
    const payload = JSON.parse(JSON.stringify(BASE_PAYLOAD));
    payload.data.options[0].value = 0; // hours <= 0
    await invokeHandler(ctrl, Buffer.from(JSON.stringify(payload), 'utf8'));
    await flushMicrotasks();
    expect(bot.calls.filter((c) => c.kind === 'followup')).toHaveLength(0);
    const edit = bot.calls.find((c) => c.kind === 'editOriginal');
    expect(edit).toBeDefined();
    expect((edit!.args as { content?: string }).content).toMatch(/Hours must be between/);
  });

  it('duplicate / mapping error does NOT call followup', async () => {
    const bot = makeBot();
    const reports = makeReports(
      new Error('A report for Discord Integration Test today already exists.'),
    );
    const prisma = makePrisma(PROFILE);
    const ctrl = makeController(reports, prisma, bot);
    await invokeHandler(ctrl, Buffer.from(JSON.stringify(BASE_PAYLOAD), 'utf8'));
    await flushMicrotasks();
    expect(bot.calls.filter((c) => c.kind === 'followup')).toHaveLength(0);
    const edit = bot.calls.find((c) => c.kind === 'editOriginal');
    expect((edit!.args as { content?: string }).content).toMatch(/already exists/);
  });

  it('no active profile does NOT call followup', async () => {
    const bot = makeBot();
    const reports = makeReports(BASE_REPORT);
    const prisma = makePrisma(null);
    const ctrl = makeController(reports, prisma, bot);
    await invokeHandler(ctrl, Buffer.from(JSON.stringify(BASE_PAYLOAD), 'utf8'));
    await flushMicrotasks();
    expect(bot.calls.filter((c) => c.kind === 'followup')).toHaveLength(0);
  });
});

describe('/report lifecycle — token hygiene', () => {
  it('does not log the interaction token on success', async () => {
    const bot = makeBot();
    const reports = makeReports(BASE_REPORT);
    const prisma = makePrisma(PROFILE);
    const ctrl = makeController(reports, prisma, bot);
    await invokeHandler(ctrl, Buffer.from(JSON.stringify(BASE_PAYLOAD), 'utf8'));
    await flushMicrotasks();
    expect(loggerOutput.join('\n')).not.toContain(TOKEN);
  });

  it('does not log the interaction token on followup failure', async () => {
    const APP_ID = '12345678901234567'; // realistic Discord app-id snowflake
    const bot = makeBot();
    bot.followupResponses = [
      { ok: false, status: 500, message: `broke on /webhooks/${APP_ID}/${TOKEN}/messages` },
    ];
    const reports = makeReports(BASE_REPORT);
    const prisma = makePrisma(PROFILE);
    const ctrl = makeController(reports, prisma, bot);
    await invokeHandler(ctrl, Buffer.from(JSON.stringify(BASE_PAYLOAD), 'utf8'));
    await flushMicrotasks();
    const joined = loggerOutput.join('\n');
    expect(joined).not.toContain(TOKEN);
    // The redaction mask should land in the log instead.
    expect(joined).toMatch(new RegExp(`webhooks/${APP_ID}/<redacted>`));
  });

  it('does not log the interaction token when createFromDiscord throws', async () => {
    const APP_ID = '12345678901234567';
    const bot = makeBot();
    const reports = makeReports(new Error(`crashed; see /webhooks/${APP_ID}/${TOKEN}`));
    const prisma = makePrisma(PROFILE);
    const ctrl = makeController(reports, prisma, bot);
    await invokeHandler(ctrl, Buffer.from(JSON.stringify(BASE_PAYLOAD), 'utf8'));
    await flushMicrotasks();
    const joined = loggerOutput.join('\n');
    expect(joined).not.toContain(TOKEN);
  });
});
