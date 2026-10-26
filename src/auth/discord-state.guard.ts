import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

/* Custom AuthGuard around the 'discord' strategy that forwards the
 * `invite` query parameter into the OAuth `state` round-trip.
 *
 * Why this exists: passport-oauth2 only round-trips the `state`
 * parameter when it is passed via `authenticate(..., { state })`
 * options; the plain `AuthGuard('discord')` builds a request with no
 * such option, so Discord returns to our callback without state and
 * `loginOrConsumeInvite` never sees the invite token.
 *
 * Nest's AuthGuard exposes `getAuthenticateOptions(ctx)` for exactly
 * this hook — override it to pull `?invite=<token>` off the request
 * and hand it to passport. The callback leg (same guard, no invite
 * query present) is a no-op — passport then auto-unpacks state onto
 * `req.query.state`, which the controller already reads. */
@Injectable()
export class DiscordAuthGuard extends AuthGuard('discord') {
  getAuthenticateOptions(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const invite =
      typeof req.query.invite === 'string' ? req.query.invite : undefined;
    return invite ? { state: invite } : {};
  }
}
