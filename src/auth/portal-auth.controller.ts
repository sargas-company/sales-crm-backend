import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { DiscordAuthGuard } from './discord-state.guard';
import type { DiscordProfile } from './discord.strategy';
import { PortalAuthService } from './portal-auth.service';

/* Portal auth — Discord OAuth entry/callback + invite preview.
 * All routes live under /auth/portal/* and are public (no JWT); the
 * callback mints a JWT on success. */
@ApiTags('Portal Auth')
@Controller('auth/portal')
export class PortalAuthController {
  constructor(private readonly svc: PortalAuthService) {}

  /** Kick-off: redirects the browser to Discord's consent screen.
   *  Supports an optional `invite` query — carried through state so
   *  the callback knows which invite to consume if the user is new. */
  @Get('discord/login')
  @UseGuards(DiscordAuthGuard)
  @ApiOperation({ summary: 'Start Discord OAuth. Query: ?invite=<token>' })
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  discordLogin(): void {
    /* Passport will intercept and redirect — this body is never
     * reached. Including the method so NestJS registers the route. */
  }

  /** Discord redirects here with code + state. Passport validates
   *  and attaches `req.user` = DiscordProfile. We finalize sign-in
   *  (existing user) or consume the invite (new user). */
  @Get('discord/callback')
  @UseGuards(DiscordAuthGuard)
  @ApiOperation({ summary: 'Discord OAuth callback — issues JWT on success.' })
  async discordCallback(
    @Req() req: Request & { user: DiscordProfile },
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    const inviteToken = state && state !== 'null' ? state : null;
    try {
      const result = await this.svc.loginOrConsumeInvite(req.user, inviteToken);
      /* Hand the token to the SPA via a short-lived fragment redirect
       * so it doesn't land in server logs. The portal UI reads it from
       * window.location.hash on `/auth/callback`. */
      const portalBase = process.env.PORTAL_PUBLIC_URL ?? '';
      res.redirect(`${portalBase}/auth/callback#token=${result.accessToken}`);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Login failed';
      const portalBase = process.env.PORTAL_PUBLIC_URL ?? '';
      res.redirect(
        `${portalBase}/portal/login?error=${encodeURIComponent(msg)}`,
      );
    }
  }

  /** Public endpoint — invite landing page calls this to render a
   *  preview of what the user is about to accept. */
  @Get('invites/:token')
  @ApiOperation({ summary: 'Public invite preview for the landing page.' })
  getInvite(@Param('token') token: string) {
    if (!token || token.length < 8) throw new BadRequestException('bad token');
    return this.svc.readInvite(token);
  }
}

/* Optional dev-only shortcut — bypasses Discord entirely for local
 * testing. Hard-gated by DEV_FAKE_DISCORD env flag + NODE_ENV check.
 * Routes are only registered when both are satisfied. */
@ApiTags('Portal Auth (dev)')
@Controller('auth/portal/dev')
export class PortalAuthDevController {
  constructor(private readonly svc: PortalAuthService) {}

  @Get('fake-login')
  @ApiOperation({
    summary:
      'DEV-ONLY: pretend to be a Discord user; mints JWT without Discord. Blocked unless DEV_FAKE_DISCORD=true and APP_ENV=local.',
  })
  async fakeLogin(
    @Query('discordId') discordId: string,
    @Query('email') email: string | undefined,
    @Query('username') username: string | undefined,
    @Query('invite') invite: string | undefined,
    @Res() res: Response,
  ) {
    if (
      process.env.DEV_FAKE_DISCORD !== 'true' ||
      process.env.APP_ENV !== 'local'
    ) {
      throw new BadRequestException('fake-login is disabled');
    }
    if (!discordId) throw new BadRequestException('discordId is required');
    const profile: DiscordProfile = {
      discordId,
      username: username ?? `dev-${discordId}`,
      email: email ?? null,
      avatarUrl: null,
    };
    try {
      const result = await this.svc.loginOrConsumeInvite(profile, invite ?? null);
      const portalBase = process.env.PORTAL_PUBLIC_URL ?? '';
      res.redirect(`${portalBase}/auth/callback#token=${result.accessToken}`);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'fake-login failed';
      const portalBase = process.env.PORTAL_PUBLIC_URL ?? '';
      res.redirect(
        `${portalBase}/portal/login?error=${encodeURIComponent(msg)}`,
      );
    }
  }
}
