import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

const CUSTOM_HEADER = 'x-vibe-worker-secret';

@Injectable()
export class VibeWorkerWebhookGuard implements CanActivate {
  private readonly logger = new Logger(VibeWorkerWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = this.config.get<string>('VIBE_WORKER_WEBHOOK_SECRET');

    if (!expected) {
      this.logger.warn(
        'VIBE_WORKER_WEBHOOK_SECRET is not configured — rejecting webhook request',
      );
      throw new UnauthorizedException();
    }

    const provided = this.extractSecret(req);
    if (!provided || !equalsConstantTime(provided, expected)) {
      throw new UnauthorizedException();
    }

    return true;
  }

  private extractSecret(req: Request): string | null {
    const custom = firstHeaderValue(req.headers[CUSTOM_HEADER]);
    if (custom) return custom;

    const auth = firstHeaderValue(req.headers['authorization']);
    if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);

    return null;
  }
}

function firstHeaderValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
    return raw[0].trim() || null;
  }
  return null;
}

function equalsConstantTime(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    const pad = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, pad);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
