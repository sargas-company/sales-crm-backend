import { afterEach, describe, expect, it, jest } from '@jest/globals';

type GetResponder = (url: string) => Promise<{ data: unknown }>;

// Build a fake axios instance whose `get(url)` is controlled by the
// provided responder. The constructor collects the Authorization
// header the client sends so we can assert it stays scoped.
function fakeAxiosFactory(responder: GetResponder) {
  const seen: Array<{ url: string; auth?: string }> = [];
  const createdHeaders: Array<Record<string, unknown>> = [];
  const factory = (config: { headers?: Record<string, unknown> }) => {
    createdHeaders.push(config.headers ?? {});
    return {
      get: async (url: string) => {
        seen.push({ url, auth: config.headers?.Authorization as string | undefined });
        return responder(url);
      },
    };
  };
  return { factory, seen, createdHeaders };
}

jest.mock('axios', () => {
  const create = jest.fn();
  return { __esModule: true, default: { create }, create };
});

// Re-require inside each test so our jest.mock takes effect first.
import axios from 'axios';
import { DiscordBotClient } from './discord-bot.client';

afterEach(() => {
  (axios.create as unknown as jest.Mock).mockReset();
  process.env.DISCORD_BOT_TOKEN = '';
});

describe('DiscordBotClient.getSelfMember — two-step lookup', () => {
  it('calls /users/@me, then /guilds/:id/members/:botUserId', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    const guildId = '1111111111111111';
    const botUserId = '9999999999999999';
    const stub = fakeAxiosFactory(async (url) => {
      if (url === '/users/@me') return { data: { id: botUserId, username: 'sargas-bot' } };
      if (url === `/guilds/${guildId}/members/${botUserId}`)
        return { data: { roles: ['r1', 'r2', 'r3'] } };
      throw new Error(`unexpected GET ${url}`);
    });
    (axios.create as unknown as jest.Mock).mockImplementation(stub.factory);

    const r = await new DiscordBotClient().getSelfMember(guildId);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe(botUserId);
      expect(r.roleIds).toEqual(['r1', 'r2', 'r3']);
    }
    expect(stub.seen.map((s) => s.url)).toEqual([
      '/users/@me',
      `/guilds/${guildId}/members/${botUserId}`,
    ]);
    // Authorization: 'Bot test-token' is attached in the axios-create
    // config — not something we log; we just verify the client did
    // scope it to the request.
    expect(stub.createdHeaders[0]?.Authorization).toBe('Bot test-token');
  });

  it('surfaces the first-call error without touching the second endpoint', async () => {
    process.env.DISCORD_BOT_TOKEN = 'bad-token';
    const guildId = '1111111111111111';
    const stub = fakeAxiosFactory(async (url) => {
      if (url === '/users/@me') {
        const err = new Error('401: Unauthorized') as Error & {
          response?: { status: number; data: { message: string } };
        };
        err.response = { status: 401, data: { message: '401: Unauthorized' } };
        throw err;
      }
      throw new Error(`should not have been called: ${url}`);
    });
    (axios.create as unknown as jest.Mock).mockImplementation(stub.factory);

    const r = await new DiscordBotClient().getSelfMember(guildId);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.message).toMatch(/Unauthorized/);
    }
    expect(stub.seen.map((s) => s.url)).toEqual(['/users/@me']);
  });

  it('surfaces the member lookup error with the resolved status', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    const guildId = '1111111111111111';
    const botUserId = '9999999999999999';
    const stub = fakeAxiosFactory(async (url) => {
      if (url === '/users/@me') return { data: { id: botUserId } };
      const err = new Error('404: Unknown Member') as Error & {
        response?: { status: number; data: { message: string } };
      };
      err.response = { status: 404, data: { message: 'Unknown Member' } };
      throw err;
    });
    (axios.create as unknown as jest.Mock).mockImplementation(stub.factory);

    const r = await new DiscordBotClient().getSelfMember(guildId);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.message).toMatch(/Unknown Member/);
    }
    expect(stub.seen.map((s) => s.url)).toEqual([
      '/users/@me',
      `/guilds/${guildId}/members/${botUserId}`,
    ]);
  });

  it('refuses to call Discord when the token is empty', async () => {
    process.env.DISCORD_BOT_TOKEN = '';
    const stub = fakeAxiosFactory(async () => ({ data: {} }));
    (axios.create as unknown as jest.Mock).mockImplementation(stub.factory);

    const r = await new DiscordBotClient().getSelfMember('1111111111111111');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/DISCORD_BOT_TOKEN/);
    expect(stub.seen.length).toBe(0);
  });

  it('scrubs `Bot <token>` substrings from an error message', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    const guildId = '1111111111111111';
    const stub = fakeAxiosFactory(async () => {
      const err = new Error('leak') as Error & {
        response?: { status: number; data: { message: string } };
      };
      err.response = {
        status: 400,
        data: { message: 'Bot abcdef.rotated-chunk.xyz leaked somewhere' },
      };
      throw err;
    });
    (axios.create as unknown as jest.Mock).mockImplementation(stub.factory);

    const r = await new DiscordBotClient().getSelfMember(guildId);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toMatch(/abcdef\.rotated-chunk\.xyz/);
      expect(r.message).toMatch(/Bot <redacted>/);
    }
  });
});
