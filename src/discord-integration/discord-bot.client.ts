import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, type AxiosInstance } from 'axios';

type ErrOk<T> = { ok: true } & T;
type ErrFail = { ok: false; status: number; message: string; retryAfterMs?: number };

/**
 * Thin wrapper around Discord's HTTP API covering the three distinct
 * authentication contexts we use:
 *
 *   1. Bot API (header `Authorization: Bot <token>`)
 *      — read channel/guild/role metadata, post to arbitrary channels.
 *   2. Interactions follow-up (no auth, keyed on application id + the
 *      per-interaction token Discord hands us in the request body)
 *      — edit the deferred ephemeral "thinking…" message and post
 *      additional follow-up messages inside the same interaction.
 *   3. Slash-command registration (Bot API, kept in the CLI script).
 *
 * The bot token is read from env at call time so a rotation applies
 * without a process restart. Interaction tokens are passed in by the
 * caller and NEVER stored or logged.
 */
@Injectable()
export class DiscordBotClient {
  private readonly logger = new Logger(DiscordBotClient.name);
  private readonly baseURL = 'https://discord.com/api/v10';
  private readonly timeout = 10_000;

  private botToken(): string {
    return process.env.DISCORD_BOT_TOKEN ?? '';
  }

  private appId(): string {
    return process.env.DISCORD_APP_ID ?? '';
  }

  private bot(): AxiosInstance {
    return axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        Authorization: `Bot ${this.botToken()}`,
        'Content-Type': 'application/json',
      },
    });
  }

  private unauthed(): AxiosInstance {
    return axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── Bot API — read-only probes ─────────────────────────────────

  async getGuild(id: string): Promise<ErrOk<{ name: string }> | ErrFail> {
    if (!this.botToken()) return { ok: false, status: 0, message: 'DISCORD_BOT_TOKEN is not set' };
    try {
      const { data } = await this.bot().get<{ name: string }>(`/guilds/${id}`);
      return { ok: true, name: data.name };
    } catch (err) {
      return this.wrapAxiosError(err);
    }
  }

  async getChannel(id: string): Promise<ErrOk<{ name?: string; type: number; guildId?: string }> | ErrFail> {
    if (!this.botToken()) return { ok: false, status: 0, message: 'DISCORD_BOT_TOKEN is not set' };
    try {
      const { data } = await this.bot().get<{ name?: string; type: number; guild_id?: string }>(
        `/channels/${id}`,
      );
      return { ok: true, name: data.name, type: data.type, guildId: data.guild_id };
    } catch (err) {
      return this.wrapAxiosError(err);
    }
  }

  async getGuildRoles(guildId: string): Promise<ErrOk<{ roles: Array<{ id: string; name: string }> }> | ErrFail> {
    if (!this.botToken()) return { ok: false, status: 0, message: 'DISCORD_BOT_TOKEN is not set' };
    try {
      const { data } = await this.bot().get<Array<{ id: string; name: string }>>(
        `/guilds/${guildId}/roles`,
      );
      return { ok: true, roles: data };
    } catch (err) {
      return this.wrapAxiosError(err);
    }
  }

  /**
   * Fetch the bot's own guild-member record so we can confirm it is
   * in the guild and read its roles for permission checks. Discord's
   * `/guilds/{id}/members/@me` only works for OAuth2 user tokens —
   * for a Bot token we have to resolve the bot's user id first via
   * `GET /users/@me`, then look it up explicitly.
   *
   * We never log the Authorization header, the token or the full
   * response body; only the derived shape (role count, status) is
   * surfaced upstream, and `wrapAxiosError` scrubs any `Bot <token>`
   * substring that might appear in a Discord error message.
   */
  async getSelfMember(guildId: string): Promise<ErrOk<{ userId: string; roleIds: string[] }> | ErrFail> {
    if (!this.botToken()) return { ok: false, status: 0, message: 'DISCORD_BOT_TOKEN is not set' };
    const client = this.bot();
    let userId: string;
    try {
      const { data } = await client.get<{ id: string }>('/users/@me');
      if (!data?.id) {
        return { ok: false, status: 0, message: 'bot user id missing from /users/@me response' };
      }
      userId = data.id;
    } catch (err) {
      return this.wrapAxiosError(err);
    }
    try {
      const { data } = await client.get<{ roles: string[] }>(
        `/guilds/${guildId}/members/${userId}`,
      );
      return { ok: true, userId, roleIds: data.roles ?? [] };
    } catch (err) {
      return this.wrapAxiosError(err);
    }
  }

  // ─── Bot API — writes ───────────────────────────────────────────

  async postMessage(args: {
    channelId: string;
    content?: string;
    embeds?: Array<Record<string, unknown>>;
    allowedMentions?: Record<string, unknown>;
  }): Promise<ErrOk<{ messageId: string }> | ErrFail> {
    if (!this.botToken()) {
      return { ok: false, status: 0, message: 'DISCORD_BOT_TOKEN is not set' };
    }
    const body: Record<string, unknown> = {};
    if (args.content) body.content = args.content;
    if (args.embeds?.length) body.embeds = args.embeds;
    if (args.allowedMentions) body.allowed_mentions = args.allowedMentions;
    try {
      const { data } = await this.bot().post<{ id: string }>(
        `/channels/${args.channelId}/messages`,
        body,
      );
      return { ok: true, messageId: data.id };
    } catch (err) {
      return this.wrapAxiosError(err);
    }
  }

  // ─── Interactions follow-up (NO Authorization header; the token in
  //     the URL is itself the proof) ────────────────────────────────

  async followup(args: {
    interactionToken: string;
    content?: string;
    embeds?: Array<Record<string, unknown>>;
    ephemeral?: boolean;
    allowedMentions?: Record<string, unknown>;
  }): Promise<ErrOk<{ messageId: string }> | ErrFail> {
    if (!this.appId()) return { ok: false, status: 0, message: 'DISCORD_APP_ID is not set' };
    const body: Record<string, unknown> = {};
    if (args.content) body.content = args.content;
    if (args.embeds?.length) body.embeds = args.embeds;
    if (args.ephemeral) body.flags = 64;
    if (args.allowedMentions) body.allowed_mentions = args.allowedMentions;
    try {
      const { data } = await this.unauthed().post<{ id: string }>(
        `/webhooks/${this.appId()}/${args.interactionToken}`,
        body,
      );
      return { ok: true, messageId: data.id };
    } catch (err) {
      return this.wrapAxiosError(err);
    }
  }

  async editOriginal(args: {
    interactionToken: string;
    content?: string;
    embeds?: Array<Record<string, unknown>>;
    allowedMentions?: Record<string, unknown>;
  }): Promise<ErrOk<{ messageId: string }> | ErrFail> {
    if (!this.appId()) return { ok: false, status: 0, message: 'DISCORD_APP_ID is not set' };
    const body: Record<string, unknown> = {};
    body.content = args.content ?? '';
    if (args.embeds?.length) body.embeds = args.embeds;
    if (args.allowedMentions) body.allowed_mentions = args.allowedMentions;
    try {
      const { data } = await this.unauthed().patch<{ id: string }>(
        `/webhooks/${this.appId()}/${args.interactionToken}/messages/@original`,
        body,
      );
      return { ok: true, messageId: data.id };
    } catch (err) {
      return this.wrapAxiosError(err);
    }
  }

  // ─── Error wrapper ──────────────────────────────────────────────

  /**
   * Normalise an axios error into a safe-to-log structure. 429
   * responses expose the suggested retry-after in ms so callers can
   * back off; everything else is terminal for the current attempt.
   * The bot token is scrubbed before the message leaves this file.
   */
  private wrapAxiosError(err: unknown): ErrFail {
    const ax = err as AxiosError<{ message?: string; retry_after?: number; code?: number }>;
    const status = ax.response?.status ?? 0;
    const body = ax.response?.data;
    const base =
      (body && typeof body.message === 'string' && body.message) ||
      ax.message ||
      'Discord API error';
    const msg = base
      // Bot <token> → redacted (bot token).
      .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot <redacted>')
      // /webhooks/<app_id>/<interaction_token>[/...] → redacted.
      // Interaction tokens are long opaque strings; axios may echo
      // the request path in `error.message`, and we don't want it
      // in logs. The app id (snowflake) is safe to keep.
      .replace(
        /\/webhooks\/(\d{17,20})\/[^\/\s]+/g,
        '/webhooks/$1/<redacted>',
      )
      .slice(0, 300);
    const retryAfterMs =
      status === 429 && body && typeof body.retry_after === 'number'
        ? Math.round(body.retry_after * 1000)
        : undefined;
    return { ok: false, status, message: msg, retryAfterMs };
  }
}
