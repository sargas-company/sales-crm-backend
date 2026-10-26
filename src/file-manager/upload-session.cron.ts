import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { UploadSessionService } from './upload-session.service';

/* Sweep expired resumable upload sessions every 15 minutes:
 *   - find OPEN sessions whose expiresAt is in the past
 *   - cancel the incomplete large file on B2 (`b2_cancel_large_file`)
 *   - mark the DB row ABORTED
 * TTL is 48h (owner-approved). Keeping this on its own class so the
 * service stays testable without the scheduler plumbing. */
@Injectable()
export class UploadSessionCron {
  private readonly logger = new Logger(UploadSessionCron.name);

  constructor(private readonly sessions: UploadSessionService) {}

  /* `0 star-slash-15 star star star star` — top of every quarter-hour. */
  @Cron('0 */15 * * * *', {
    name: 'file-manager-upload-session-sweep',
  })
  async tick(): Promise<void> {
    try {
      await this.sessions.sweepExpired();
    } catch (err: unknown) {
      this.logger.error(
        `sweepExpired threw: ${(err as { message?: string })?.message ?? err}`,
      );
    }
  }
}
