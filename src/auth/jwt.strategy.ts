import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

// JWT carries identity only. Role and permissions are resolved from
// the DB per protected request by `PermissionGuard`.
export interface JwtPayload {
  sub: string;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      // Bearer header only. The previous `?token=` query fallback was
      // dropped during the file-layer stabilisation — JWTs in query
      // strings leak into server logs, Referer headers and browser
      // history. Private downloads now go through the SPA with axios +
      // blob + object URL (see `src/page/portfolio/*`).
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  validate(payload: JwtPayload) {
    return { id: payload.sub, email: payload.email };
  }
}
