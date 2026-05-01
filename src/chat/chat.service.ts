import { Injectable, NotFoundException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import { AnthropicService } from '../anthropic/anthropic.service';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../prompt/prompt.service';

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const HISTORY_LIMIT = 10;

const ANALYZE_TOOL: Anthropic.Tool = {
  name: 'analyze_intent',
  description: 'Analyze the manager request and decide what action to take',
  input_schema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['bid', 'decline', 'clarify'],
        description:
          'bid — write a proposal, decline — politely refuse, clarify — ask for more info',
      },
      reasoning: {
        type: 'string',
        description: 'Short explanation of the decision (1-2 sentences)',
      },
    },
    required: ['decision', 'reasoning'],
  },
};

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promptService: PromptService,
    private readonly anthropicService: AnthropicService,
  ) {}

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private getSystemPrompt(): Promise<string> {
    return this.promptService.getChatPrompt();
  }

  private async prepareContext(proposalId: string, content: string) {
    const chat = await this.prisma.chat.findUnique({ where: { proposalId } });

    const [systemPrompt, recentMessages, proposal] = await Promise.all([
      this.getSystemPrompt(),
      chat
        ? this.prisma.chatMessage
            .findMany({
              where: { chatId: chat.id },
              orderBy: { createdAt: 'desc' },
              take: HISTORY_LIMIT,
            })
            .then((msgs) => msgs.reverse())
        : Promise.resolve([]),
      this.prisma.proposal.findUnique({ where: { id: proposalId } }),
    ]);

    const knowledgeBlock = '';

    const system = [systemPrompt, knowledgeBlock].join('');

    const userMessage = [
      `VACANCY:\n${proposal?.vacancy || '(not specified)'}`,
      `MESSAGE:\n${content}`,
    ].join('\n\n');

    const messages: Anthropic.MessageParam[] = [
      ...recentMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: userMessage },
    ];

    return { system, messages };
  }

  private async analyzeIntent(
    context: { system: string; messages: Anthropic.MessageParam[] },
    model = CLAUDE_MODEL,
  ): Promise<{ decision: string; reasoning: string }> {
    const response = await this.anthropicService.client.messages.create({
      model,
      max_tokens: 256,
      system: context.system,
      messages: context.messages,
      tools: [ANALYZE_TOOL],
      tool_choice: { type: 'tool', name: 'analyze_intent' },
    });

    const toolBlock = response.content.find(
      (c) => c.type === 'tool_use' && c.name === 'analyze_intent',
    ) as Anthropic.ToolUseBlock | undefined;

    if (!toolBlock) {
      throw new Error('analyzeIntent: tool_use block not found in response');
    }

    const input = toolBlock.input as { decision: string; reasoning: string };
    return { decision: input.decision, reasoning: input.reasoning };
  }

  // ─── Admin: list all chats ────────────────────────────────────────────────────

  async listAll(limit: number, cursor?: string, type?: 'proposal' | 'lead') {
    const where =
      type === 'proposal'
        ? { proposalId: { not: null } }
        : type === 'lead'
          ? { leadId: { not: null } }
          : undefined;

    const items = await this.prisma.chat.findMany({
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
      ...(where && { where }),
      include: {
        proposal: { include: { user: { select: { id: true, email: true } } } },
        lead: true,
        _count: { select: { messages: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const hasNextPage = items.length > limit;
    const data = hasNextPage ? items.slice(0, limit) : items;
    const nextCursor = hasNextPage ? data[data.length - 1].id : null;

    return { data, nextCursor };
  }

  // ─── Analyze only ─────────────────────────────────────────────────────────────

  async analyzeOnly(
    proposalId: string,
    content: string,
  ): Promise<{ decision: string; reasoning: string }> {
    const proposal = await this.prisma.proposal.findUnique({
      where: { id: proposalId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');

    const context = await this.prepareContext(proposalId, content);
    return this.analyzeIntent(context);
  }
}
