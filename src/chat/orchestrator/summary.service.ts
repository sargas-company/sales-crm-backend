import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Anthropic from '@anthropic-ai/sdk';

import { AnthropicService } from '../../anthropic/anthropic.service';
import {
  ACTIVE_CHAT_WINDOW_HOURS,
  HISTORY_KEEP_RECENT,
  HISTORY_MAX_OLD,
  SUMMARY_BATCH_SIZE,
  SUMMARY_MAX_LENGTH,
  SUMMARY_MODEL,
} from './pipeline.config';
import { PrismaService } from '../../prisma/prisma.service';

const SUMMARY_SYSTEM_PROMPT = `You are summarizing a conversation.
Your goal is to compress the conversation into a short, structured summary.

Rules:
* keep key facts
* keep user goals
* keep important decisions
* remove repetition
* do not include dialogue format
* do not write "User said..."
* write as a clean summary`;

@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropicService: AnthropicService,
  ) {}

  async getLatestSummary(chatId: string): Promise<string | null> {
    const record = await this.prisma.chatSummary.findUnique({
      where: { chatId },
    });
    return record?.summary ?? null;
  }

  async generateSummary(chatId: string): Promise<string> {
    const [allMessages, previousSummary] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true },
      }),
      this.getLatestSummary(chatId),
    ]);

    const oldMessages = allMessages
      .slice(0, -HISTORY_KEEP_RECENT)
      .slice(-HISTORY_MAX_OLD);

    if (!oldMessages.length) return previousSummary ?? '';

    const conversationText = oldMessages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    const safeConversation =
      conversationText.length > 4000
        ? conversationText.slice(0, 4000).replace(/\s+\S*$/, '')
        : conversationText;

    const inputParts: string[] = [];
    if (previousSummary) {
      inputParts.push(`[PREVIOUS SUMMARY]\n${previousSummary}`);
    }
    inputParts.push(`[NEW MESSAGES]\n${safeConversation}`);
    const userContent = inputParts.join('\n\n');

    try {
      const response = await this.anthropicService.client.messages.create({
        model: SUMMARY_MODEL,
        max_tokens: 512,
        temperature: 0,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim()
        .slice(0, SUMMARY_MAX_LENGTH);

      return text || (previousSummary ?? '');
    } catch (error) {
      this.logger.error(
        `LLM call failed for chat ${chatId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return previousSummary ?? '';
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runDailySummaryUpdate(): Promise<void> {
    const since = new Date(
      Date.now() - ACTIVE_CHAT_WINDOW_HOURS * 60 * 60 * 1000,
    );

    const activeChats = await this.prisma.chat.findMany({
      where: { messages: { some: { createdAt: { gte: since } } } },
      select: { id: true },
    });

    this.logger.log(`runDailySummaryUpdate | activeChats=${activeChats.length}`);

    for (let i = 0; i < activeChats.length; i += SUMMARY_BATCH_SIZE) {
      const batch = activeChats.slice(i, i + SUMMARY_BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async ({ id: chatId }) => {
          try {
            const summary = await this.generateSummary(chatId);
            if (summary) await this.upsertSummary(chatId, summary);
          } catch (error) {
            this.logger.error(
              `Failed for chat ${chatId}`,
              error instanceof Error ? error.stack : String(error),
            );
          }
        }),
      );
    }
  }

  async upsertSummary(chatId: string, summary: string): Promise<void> {
    await this.prisma.chatSummary.upsert({
      where: { chatId },
      update: { summary },
      create: { chatId, summary },
    });
  }
}
