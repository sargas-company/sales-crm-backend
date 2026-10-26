import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-discord';

/* Discord OAuth strategy — ONLY for the file-portal workers surface
 * served under files.sargas.io. Admins never pass through here.
 *
 * Env wiring:
 *   DISCORD_CLIENT_ID     — Discord OAuth app client id
 *   DISCORD_CLIENT_SECRET — Discord OAuth app client secret
 *   DISCORD_CALLBACK_URL  — exact redirect URL registered in the
 *                            Discord Developer Portal, e.g.
 *                            http://files.localhost:5173/auth/discord/callback
 *                            (local) or https://files.sargas.io/...
 *                            (prod)
 *
 * The validated profile is handed to `AuthController` which checks
 * whether the discordId is bound to an existing portal user OR
 * backed by a pending invite — and acts accordingly. */
/* passport-oauth2 throws at construction if clientID/clientSecret
 * are empty strings, which would crash the whole app on boot when
 * the owner hasn't yet created the Discord OAuth app. Fall back to
 * explicit "unset-*" placeholders so the strategy initialises; the
 * OAuth flow itself will fail with a clear 400 from Discord if the
 * user triggers it without configuring the real env vars. */
const UNSET_CLIENT_ID = 'unset-discord-client-id';
const UNSET_CLIENT_SECRET = 'unset-discord-client-secret';
const UNSET_CALLBACK_URL =
  'http://files.localhost:5173/auth/discord/callback';

@Injectable()
export class DiscordStrategy extends PassportStrategy(Strategy, 'discord') {
  constructor() {
    super({
      clientID: process.env.DISCORD_CLIENT_ID || UNSET_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET || UNSET_CLIENT_SECRET,
      callbackURL: process.env.DISCORD_CALLBACK_URL || UNSET_CALLBACK_URL,
      scope: ['identify', 'email'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<DiscordProfile> {
    return {
      discordId: profile.id,
      username: profile.username,
      email: profile.email ?? null,
      avatarUrl: profile.avatar
        ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
        : null,
    };
  }
}

export interface DiscordProfile {
  discordId: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
}
