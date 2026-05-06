import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { MessageAttachmentStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ChatBroadcastService } from '../chat-broadcast.service';
import { MessageReadinessService } from './message-readiness.service';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;

const STUCK_STATUSES = [
  MessageAttachmentStatus.PENDING,
  MessageAttachmentStatus.PROCESSING,
];

@Injectable()
export class AttachmentRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AttachmentRecoveryService.name);
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly readiness: MessageReadinessService,
  ) {}

  onModuleInit(): void {
    this.startupTimer = setTimeout(() => {
      void this.recoverStuckAttachments();
    }, STARTUP_DELAY_MS);

    this.intervalHandle = setInterval(() => {
      void this.recoverStuckAttachments();
    }, RECOVERY_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async recoverStuckAttachments(): Promise<void> {
    if (this.isRunning) {
      this.logger.debug('attachment recovery already running, skipping');
      return;
    }
    this.isRunning = true;
    try {
      await this.doRecover();
    } finally {
      this.isRunning = false;
    }
  }

  private async doRecover(): Promise<void> {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

    let stuckAttachments: Array<{
      id: string;
      messageId: string;
      fileName: string;
      updatedAt: Date;
      message: { chat: { proposalId: string | null } };
    }>;

    try {
      stuckAttachments = await this.prisma.messageAttachment.findMany({
        where: {
          status: { in: STUCK_STATUSES },
          updatedAt: { lt: staleThreshold },
        },
        select: {
          id: true,
          messageId: true,
          fileName: true,
          updatedAt: true,
          message: {
            select: { chat: { select: { proposalId: true } } },
          },
        },
      });
    } catch (err) {
      this.logger.error(
        'attachment recovery query failed',
        err instanceof Error ? err.stack : String(err),
      );
      return;
    }

    if (stuckAttachments.length === 0) return;

    this.logger.warn(
      `attachment recovery: found ${stuckAttachments.length} stuck attachment(s) (PENDING/PROCESSING)`,
    );

    const affectedMessageIds = new Set<string>();

    for (const att of stuckAttachments) {
      const staleDuration = Date.now() - att.updatedAt.getTime();

      // Optimistic update — covers both PENDING and PROCESSING
      const { count } = await this.prisma.messageAttachment
        .updateMany({
          where: {
            id: att.id,
            status: { in: STUCK_STATUSES },
          },
          data: {
            status: MessageAttachmentStatus.FAILED,
            error: 'Attachment recovery timeout',
          },
        })
        .catch((err: unknown) => {
          this.logger.error(
            `attachment recovery update failed for ${att.id}`,
            err instanceof Error ? err.stack : String(err),
          );
          return { count: 0 };
        });

      if (count === 0) {
        this.logger.debug(
          `attachment recovery: ${att.id} already transitioned, skipping`,
        );
        continue;
      }

      this.logger.warn(
        `attachment recovery: ${att.id} recovered | messageId=${att.messageId} fileName=${att.fileName} staleDuration=${staleDuration}ms`,
      );

      const proposalId = att.message.chat.proposalId;
      if (proposalId) {
        this.broadcast.broadcastAttachmentUpdate(proposalId, {
          attachmentId: att.id,
          messageId: att.messageId,
          status: 'FAILED',
          error: 'Attachment recovery timeout',
        });
      }

      affectedMessageIds.add(att.messageId);
    }

    // Trigger readiness check once per affected message (deduplicated)
    for (const messageId of affectedMessageIds) {
      await this.readiness
        .checkMessageReadiness(messageId)
        .catch((err: unknown) => {
          this.logger.error(
            `readiness check failed after attachment recovery for message ${messageId}`,
            err instanceof Error ? err.stack : String(err),
          );
        });
    }
  }
}
