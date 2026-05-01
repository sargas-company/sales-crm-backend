import { Injectable } from '@nestjs/common';

import { PromptService } from '../../prompt/prompt.service';
import {
  HISTORY_LIMIT,
  JOB_POST_LIMIT,
  KNOWLEDGE_SEPARATOR,
  USER_CONTENT_LIMIT,
} from './pipeline.config';
import { BuiltPrompt, PromptInput, SystemBlock } from './types';

@Injectable()
export class PromptAssemblyService {
  constructor(private readonly promptService: PromptService) {}

  async buildPrompt(input: PromptInput): Promise<BuiltPrompt> {
    const systemBlocks = await this.buildSystemBlocks(input);
    const messages = this.buildMessages(input);
    return { systemBlocks, messages };
  }

  private async buildSystemBlocks(input: PromptInput): Promise<SystemBlock[]> {
    const base = await this.promptService.getChatPrompt();

    const blocks: SystemBlock[] = [
      { type: 'text', text: base, cache_control: { type: 'ephemeral' } },
    ];

    const dynamicParts: string[] = [];

    if (input.summary) {
      dynamicParts.push(`[CONVERSATION SUMMARY]\n${input.summary}`);
    }

    if (input.knowledgeSnippets.length) {
      const docs = input.knowledgeSnippets.join(KNOWLEDGE_SEPARATOR);
      dynamicParts.push(`[RELEVANT KNOWLEDGE]\n\n---\n\n${docs}\n\n---`);
    }

    if (dynamicParts.length) {
      blocks.push({ type: 'text', text: dynamicParts.join('\n\n') });
    }

    return blocks;
  }

  private buildMessages(input: PromptInput): BuiltPrompt['messages'] {
    const history = input.history.slice(-HISTORY_LIMIT).map((m) => ({
      role: m.role,
      content:
        m.role === 'user'
          ? `[USER]\n${m.content}`
          : `[ASSISTANT]\n${m.content}`,
    }));

    return [
      ...history,
      { role: 'user', content: this.buildUserMessage(input) },
    ];
  }

  private buildUserMessage(input: PromptInput): string {
    const parts: string[] = [];

    const vacancy = input.domainContext.proposal?.vacancy;
    if (vacancy) {
      parts.push(`[VACANCY]\n${vacancy}`);
    }

    const rawText = input.domainContext.proposal?.jobPost?.rawText;
    if (rawText) {
      parts.push(`[JOB POST]\n${rawText.slice(0, JOB_POST_LIMIT)}`);
    }

    const safeContent = input.userContent.slice(0, USER_CONTENT_LIMIT);
    parts.push(`[USER MESSAGE]\n${safeContent}`);

    return parts.join('\n\n');
  }
}
