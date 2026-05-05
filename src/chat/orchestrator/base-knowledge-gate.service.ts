import { Injectable, Logger } from '@nestjs/common';
import { ChatMessage, MessageAttachment } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';

import { AnthropicService } from '../../anthropic/anthropic.service';
import { GATE_MODEL } from './pipeline.config';

const SYSTEM_PROMPT = `You are a Base Knowledge Gate.

Your task is to decide whether the final assistant response needs user/company-specific Base Knowledge.

Do not answer the user.
Do not select specific knowledge items.

Base Knowledge means:
* portfolio cases
* reusable proposal fragments
* pricing rules
* company positioning
* writing style rules

Use Base Knowledge only if it would materially improve the final answer.

Return false for:
* translation
* explanation of provided text
* simple replies
* grammar fixes
* obvious answers from context

Return true for:
* writing proposals
* analyzing job posts
* estimates
* sales communication
* applying company-specific rules

Return JSON only:

{"needsBaseKnowledge": true}

❗ No text outside JSON
❗ No explanations
❗ No comments`;

const FALLBACK = { needsBaseKnowledge: false } as const;

export interface BaseKnowledgeGateInput {
  latestUserMessage: string;
  summary: string | null;
  recentMessages: ChatMessage[];
  latestAttachments: MessageAttachment[];
}

@Injectable()
export class BaseKnowledgeGateService {
  private readonly logger = new Logger(BaseKnowledgeGateService.name);

  constructor(private readonly anthropicService: AnthropicService) {}

  async decide(
    input: BaseKnowledgeGateInput,
  ): Promise<{ needsBaseKnowledge: boolean }> {
    const userMessage = this.buildUserMessage(input);

    try {
      const response = await this.anthropicService.client.messages.create({
        model: GATE_MODEL,
        max_tokens: 64,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');

      const result = this.parseResult(text);

      this.logger.log(
        `base-knowledge gate | needsBaseKnowledge=${result.needsBaseKnowledge}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        'base-knowledge gate API call failed',
        error instanceof Error ? error.stack : String(error),
      );
      return FALLBACK;
    }
  }

  private buildUserMessage(input: BaseKnowledgeGateInput): string {
    const parts: string[] = [
      `[LATEST USER MESSAGE]\n${input.latestUserMessage.slice(0, 1000)}`,
    ];

    if (input.summary) {
      parts.push(`[SUMMARY]\n${input.summary.slice(0, 800)}`);
    }

    if (input.recentMessages.length > 0) {
      const history = input.recentMessages
        .map((m) => {
          const label = m.role === 'user' ? '[USER]' : '[ASSISTANT]';
          return `${label}\n${m.content.slice(0, 400)}`;
        })
        .join('\n\n');
      parts.push(`[RECENT MESSAGES]\n${history}`);
    }

    if (input.latestAttachments.length > 0) {
      const files = input.latestAttachments.map((a) => a.fileName).join(', ');
      parts.push(`[ATTACHMENTS]\n${files}`);
    }

    return parts.join('\n\n');
  }

  private parseResult(text: string): { needsBaseKnowledge: boolean } {
    try {
      const cleaned = text
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```$/m, '')
        .trim();

      const json = JSON.parse(cleaned);

      if (typeof json.needsBaseKnowledge !== 'boolean') {
        this.logger.warn(
          'base-knowledge gate returned invalid JSON, using fallback',
        );
        return FALLBACK;
      }

      return { needsBaseKnowledge: json.needsBaseKnowledge };
    } catch {
      this.logger.warn('base-knowledge gate JSON parse failed, using fallback');
      return FALLBACK;
    }
  }
}
