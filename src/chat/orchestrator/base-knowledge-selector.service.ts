import { Injectable, Logger } from '@nestjs/common';
import {
  ChatMessage,
  KnowledgeDocument,
  MessageAttachment,
} from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';

import { AnthropicService } from '../../anthropic/anthropic.service';
import {
  CONTENT_FILTER_DOC_LIMIT,
  SELECTOR_MODEL,
} from './pipeline.config';

const SYSTEM_PROMPT = `You are a Base Knowledge Selector.

Your task is to analyze:
1. Current user request
2. Conversation summary, if provided
3. Recent raw messages
4. Latest attachments, if provided
5. Full content of all active Base Knowledge items

Do not answer the user.
Do not write the final response.
Do not rewrite or summarize Base Knowledge.
Do not return text fragments.
Do not return titles.
Do not invent IDs.

Selection rules:
* Analyze the full content of every Base Knowledge item
* Select an item only if its content can materially improve the final answer
* Do not select items just because the title looks related
* Do not select items "just in case"
* Prefer fewer, more relevant items
* If no item is useful, return an empty array
* If multiple items overlap, select only the most relevant ones
* Return only UUID string IDs exactly as they appear in [KNOWLEDGE ID: ...]
* The latest user message has the highest priority
* Conversation summary and recent messages are context, not the main task

Return JSON only:

{"selectedKnowledgeIds": ["uuid-1", "uuid-2"]}

❗ No text outside JSON
❗ No explanations`;

const FALLBACK = { selectedKnowledgeIds: [] as string[] };

export interface BaseKnowledgeSelectorInput {
  latestUserMessage: string;
  summary: string | null;
  recentMessages: ChatMessage[];
  latestAttachments: MessageAttachment[];
  knowledgeItems: KnowledgeDocument[];
}

@Injectable()
export class BaseKnowledgeSelectorService {
  private readonly logger = new Logger(BaseKnowledgeSelectorService.name);

  constructor(private readonly anthropicService: AnthropicService) {}

  async select(
    input: BaseKnowledgeSelectorInput,
  ): Promise<{ selectedKnowledgeIds: string[] }> {
    if (input.knowledgeItems.length === 0) {
      return FALLBACK;
    }

    const userMessage = this.buildUserMessage(input);

    try {
      const response = await this.anthropicService.client.messages.create({
        model: SELECTOR_MODEL,
        max_tokens: 256,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');

      const result = this.parseResult(
        text,
        input.knowledgeItems.map((k) => k.id),
      );

      this.logger.log(
        `base-knowledge selector | selected=${result.selectedKnowledgeIds.length}/${input.knowledgeItems.length} | ids=[${result.selectedKnowledgeIds.join(', ')}]`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        'base-knowledge selector API call failed',
        error instanceof Error ? error.stack : String(error),
      );
      return FALLBACK;
    }
  }

  private buildUserMessage(input: BaseKnowledgeSelectorInput): string {
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

    const knowledgeList = input.knowledgeItems
      .map((k) => {
        const content = k.content.slice(0, CONTENT_FILTER_DOC_LIMIT);
        return `[KNOWLEDGE ID: ${k.id}]\n${k.title ?? '(no title)'}\n\n${content}`;
      })
      .join('\n\n---\n\n');

    parts.push(`[KNOWLEDGE ITEMS]\n\n${knowledgeList}`);

    return parts.join('\n\n');
  }

  private parseResult(
    text: string,
    validIds: string[],
  ): { selectedKnowledgeIds: string[] } {
    try {
      const cleaned = text
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```$/m, '')
        .trim();

      let parsed: unknown;

      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) {
          this.logger.warn(
            `parseResult: no JSON object found | raw="${cleaned.slice(0, 200)}"`,
          );
          return FALLBACK;
        }
        parsed = JSON.parse(match[0]);
      }

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as Record<string, unknown>).selectedKnowledgeIds)
      ) {
        this.logger.warn('parseResult: invalid response shape, using fallback');
        return FALLBACK;
      }

      const raw = (parsed as Record<string, unknown>)
        .selectedKnowledgeIds as unknown[];

      const validSet = new Set(validIds);
      const selectedKnowledgeIds = [
        ...new Set(
          raw.filter(
            (id): id is string => typeof id === 'string' && validSet.has(id),
          ),
        ),
      ];

      return { selectedKnowledgeIds };
    } catch {
      this.logger.warn('parseResult: JSON parse failed, using fallback');
      return FALLBACK;
    }
  }
}
