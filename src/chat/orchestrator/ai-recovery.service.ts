import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ChatBroadcastService } from '../chat-broadcast.service';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000; // allow services to fully initialize

@Injectable()
export class AiRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiRecoveryService.name);
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
  ) {}

  onModuleInit(): void {
    // Initial run after startup — cleans up orphans left by previous crash/restart
    this.startupTimer = setTimeout(() => {
      void this.recoverStuckMessages();
    }, STARTUP_DELAY_MS);

    this.intervalHandle = setInterval(() => {
      void this.recoverStuckMessages();
    }, RECOVERY_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async recoverStuckMessages(): Promise<void> {
    if (this.isRunning) {
      this.logger.debug('AI recovery already running, skipping');
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

    let stuckMessages: Array<{
      id: string;
      updatedAt: Date;
      chat: { proposalId: string | null };
    }>;

    try {
      stuckMessages = (await this.prisma.chatMessage.findMany({
        where: {
          status: 'AI_PROCESSING',
          updatedAt: { lt: staleThreshold },
        } as never,
        include: {
          chat: { select: { proposalId: true } },
        },
      })) as unknown as Array<{
        id: string;
        updatedAt: Date;
        chat: { proposalId: string | null };
      }>;
    } catch (err) {
      this.logger.error(
        'AI recovery query failed',
        err instanceof Error ? err.stack : String(err),
      );
      return;
    }

    if (stuckMessages.length === 0) return;

    this.logger.warn(
      `AI recovery: found ${stuckMessages.length} stuck AI_PROCESSING message(s)`,
    );

    for (const message of stuckMessages) {
      const staleDuration = Date.now() - message.updatedAt.getTime();

      // Optimistic update — skip if another process already transitioned this
      const { count } = await this.prisma.chatMessage
        .updateMany({
          where: { id: message.id, status: 'AI_PROCESSING' } as never,
          data: { status: 'FAILED' } as never,
        })
        .catch((err: unknown) => {
          this.logger.error(
            `AI recovery update failed for message ${message.id}`,
            err instanceof Error ? err.stack : String(err),
          );
          return { count: 0 };
        });

      if (count === 0) {
        this.logger.debug(
          `AI recovery: message ${message.id} already transitioned, skipping`,
        );
        continue;
      }

      const { proposalId } = message.chat;
      this.logger.warn(
        `AI recovery: message ${message.id} recovered | proposalId=${proposalId ?? 'none'} staleDuration=${staleDuration}ms`,
      );

      if (proposalId) {
        this.broadcast.broadcastMessageUpdate(proposalId, {
          messageId: message.id,
          status: 'FAILED',
        });
        this.broadcast.broadcastError(
          proposalId,
          message.id,
          'AI processing was interrupted and could not be recovered. Please try again.',
        );
      }
    }
  }
}
