import { Injectable, Logger } from '@nestjs/common';

import { ChatBroadcastService } from '../chat-broadcast.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatMessageOrchestratorService } from './chat-message-orchestrator.service';

const TERMINAL = new Set(['DONE', 'FAILED']);
const SUCCESSFUL = 'DONE';
const AI_TRIGGER_STATUSES = new Set(['READY_FOR_AI', 'PARTIAL_READY']);

@Injectable()
export class MessageReadinessService {
  private readonly logger = new Logger(MessageReadinessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly orchestrator: ChatMessageOrchestratorService,
  ) {}

  /**
   * Unified readiness check — handles both text-only and file messages.
   *
   * socketId is optional: when provided (HTTP path), AI events are sent both
   * to the proposal room AND directly to that socket so clients that haven't
   * joined the room still receive them.
   *
   * Text-only (CASE E):  status=READY_FOR_AI, no attachments → trigger AI directly.
   * File messages (CASES A–D): analyse attachment terminal states, transition
   *   message status to READY_FOR_AI / PARTIAL_READY, then trigger AI.
   * CASE C (all FAILED): message stays PREPARING_ATTACHMENTS, no AI.
   * CASE D (in progress): no-op, wait for remaining workers.
   *
   * All concurrent calls are safe via optimistic updateMany guards.
   */
  async checkMessageReadiness(
    messageId: string,
    socketId?: string,
  ): Promise<void> {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      include: {
        chat: {
          select: {
            proposalId: true,
            proposal: { select: { userId: true } },
          },
        },
        attachments: { select: { status: true } },
      },
    });

    if (!message) {
      this.logger.warn(`readiness check: message ${messageId} not found`);
      return;
    }

    const { proposalId } = message.chat;
    const userId = message.chat.proposal?.userId ?? null;
    const currentStatus = (message as unknown as { status?: string }).status;

    // ── CASE E: text-only ─────────────────────────────────────────────────────
    if (message.attachments.length === 0) {
      if (currentStatus !== 'READY_FOR_AI') return;
      this.logger.log(
        `readiness detected text-only READY_FOR_AI for message ${messageId}`,
      );
      if (proposalId && userId) {
        this.triggerAiExecution(
          messageId,
          proposalId,
          userId,
          message.content,
          socketId,
        );
      } else {
        this.logger.warn(
          `AI trigger skipped for text-only message ${messageId} — missing proposalId or userId`,
        );
      }
      return;
    }

    // ── File message: analyse attachment statuses ─────────────────────────────

    const statuses = message.attachments.map(
      (a) => (a as unknown as { status: string }).status,
    );

    const hasInProgress = statuses.some((s) => !TERMINAL.has(s));
    if (hasInProgress) {
      const inProgressCount = statuses.filter((s) => !TERMINAL.has(s)).length;
      this.logger.debug(
        `readiness: ${inProgressCount}/${statuses.length} attachment(s) still in progress for message ${messageId}`,
      );
      return;
    }

    const doneCount = statuses.filter((s) => s === SUCCESSFUL).length;
    const failedCount = statuses.length - doneCount;

    let nextStatus: string;

    if (doneCount === statuses.length) {
      nextStatus = 'READY_FOR_AI';
    } else if (doneCount > 0) {
      nextStatus = 'PARTIAL_READY';
    } else {
      this.logger.warn(
        `readiness check: all ${failedCount} attachment(s) failed for message ${messageId} — staying PREPARING_ATTACHMENTS`,
      );
      return;
    }

    if (currentStatus === nextStatus) {
      this.logger.debug(
        `readiness check: message ${messageId} already at ${nextStatus}`,
      );
      return;
    }

    const { count } = await this.prisma.chatMessage.updateMany({
      where: { id: messageId, status: currentStatus } as never,
      data: { status: nextStatus } as never,
    });

    if (count === 0) {
      this.logger.debug(
        `readiness race detected for message ${messageId} — status changed concurrently, skipping`,
      );
      return;
    }

    this.logger.log(
      `message ${messageId} became ${nextStatus} | done=${doneCount} failed=${failedCount}`,
    );

    if (proposalId) {
      this.broadcast.broadcastMessageUpdate(proposalId, {
        messageId,
        status: nextStatus,
      });
    }

    if (proposalId && userId) {
      this.triggerAiExecution(
        messageId,
        proposalId,
        userId,
        message.content,
        socketId,
      );
    } else {
      this.logger.warn(
        `AI trigger skipped for message ${messageId} — missing proposalId or userId`,
      );
    }
  }

  /**
   * Single owner of the AI execution lifecycle.
   * socketId, when provided, is used as a direct-socket fallback alongside
   * room broadcast — so clients not yet in the room still receive AI events.
   *
   * Strict save order on success:
   *   1. stream completed
   *   2. save assistant (exactly once, never partial)
   *   3. userMessage → DONE
   *   4. broadcast message_updated DONE
   *   5. broadcast done
   *
   * On failure:
   *   1. log error
   *   2. userMessage → FAILED  (no assistant save)
   *   3. broadcast message_updated FAILED
   *   4. broadcast error
   *
   * TODO(recovery): messages stuck in AI_PROCESSING after a Node crash are orphaned.
   *   Detection: WHERE status='AI_PROCESSING' AND updatedAt < NOW() - interval '5 minutes'.
   *   Recovery: a cron worker should transition these to FAILED and notify clients.
   *   The (status, updatedAt) index on ChatMessage is in place for this query.
   */
  private triggerAiExecution(
    messageId: string,
    proposalId: string,
    userId: string,
    content: string,
    socketId?: string,
  ): void {
    void (async () => {
      // Atomic guard — only one caller wins even under concurrent readiness checks
      const { count } = await this.prisma.chatMessage.updateMany({
        where: {
          id: messageId,
          status: { in: [...AI_TRIGGER_STATUSES] },
        } as never,
        data: { status: 'AI_PROCESSING' } as never,
      });

      if (count === 0) {
        this.logger.debug(
          `skipping duplicate AI start for message ${messageId} — already AI_PROCESSING or beyond`,
        );
        return;
      }

      const startedAt = Date.now();
      this.logger.log(
        `AI started | messageId=${messageId} proposalId=${proposalId} socketId=${socketId ?? 'none'}`,
      );
      this.broadcast.broadcastMessageUpdate(
        proposalId,
        { messageId, status: 'AI_PROCESSING' },
        socketId,
      );

      try {
        this.broadcast.broadcastThinking(proposalId, messageId, socketId);

        const { chatId, stream } = await this.orchestrator.buildStream(
          proposalId,
          content,
          userId,
          messageId,
        );

        let fullText = '';
        for await (const chunk of stream) {
          fullText += chunk;
          this.broadcast.broadcastChunk(proposalId, messageId, chunk, socketId);
        }

        // ── Steps 2+3: save assistant and mark user message DONE atomically ────
        const [assistant] = await this.prisma.$transaction([
          this.prisma.chatMessage.create({
            data: {
              chatId,
              role: 'assistant',
              content: fullText,
              status: 'DONE',
            } as never,
          }),
          this.prisma.chatMessage.updateMany({
            where: { id: messageId, status: 'AI_PROCESSING' } as never,
            data: { status: 'DONE' } as never,
          }),
        ]);
        this.logger.log(
          `assistant saved | assistantMessageId=${assistant.id} chars=${fullText.length}`,
        );

        this.broadcast.broadcastMessageUpdate(
          proposalId,
          { messageId, status: 'DONE' },
          socketId,
        );
        this.broadcast.broadcastDone(proposalId, messageId, socketId);

        const duration = Date.now() - startedAt;
        this.logger.log(
          `AI completed | messageId=${messageId} chars=${fullText.length} duration=${duration}ms`,
        );
      } catch (err) {
        const duration = Date.now() - startedAt;
        this.logger.error(
          `AI failed | messageId=${messageId} duration=${duration}ms`,
          err instanceof Error ? err.stack : String(err),
        );

        await this.prisma.chatMessage
          .updateMany({
            where: { id: messageId, status: 'AI_PROCESSING' } as never,
            data: { status: 'FAILED' } as never,
          })
          .catch(() => undefined);

        this.broadcast.broadcastMessageUpdate(
          proposalId,
          { messageId, status: 'FAILED' },
          socketId,
        );
        this.broadcast.broadcastError(
          proposalId,
          messageId,
          err instanceof Error ? err.message : 'AI pipeline error',
          socketId,
        );
      }
    })();
  }
}
