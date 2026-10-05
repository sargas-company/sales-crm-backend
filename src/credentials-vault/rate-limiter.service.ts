import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

/**
 * In-memory sliding-window rate limiter used by sensitive credential
 * endpoints (reveal, MFA challenge, attachment download). Keyed by
 * `<scope>:<userId>`.
 *
 * Phase-5 note: this is intentionally simple. A single-process store is
 * enough while the CRM runs on one Node instance. A future multi-instance
 * deployment should swap this for a Redis-backed limiter — the surface
 * (`consume`) stays identical so callers do not change.
 */
@Injectable()
export class VaultRateLimiterService {
  private readonly logger = new Logger(VaultRateLimiterService.name);
  private readonly hits = new Map<string, number[]>();

  /**
   * Records one hit. Returns silently on success; throws
   * `429 Too Many Requests` when the caller exceeds `limit` calls per
   * `windowMs`. Cleanup of stale entries happens inline — no timer.
   */
  consume(
    scope: string,
    userId: string,
    limit: number,
    windowMs: number,
  ): void {
    const key = `${scope}:${userId}`;
    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = this.hits.get(key) ?? [];
    // Drop stale entries. This keeps the array bounded per-key.
    let fresh = hits.filter((t) => t > cutoff);
    if (fresh.length >= limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many attempts. Try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    fresh.push(now);
    this.hits.set(key, fresh);

    // Occasional GC: when the map holds too many keys, drop those with no
    // fresh hits. Cheap enough to run on the write path.
    if (this.hits.size > 5000) {
      for (const [k, ts] of this.hits) {
        if (ts.every((t) => t <= cutoff)) this.hits.delete(k);
      }
    }
  }
}
