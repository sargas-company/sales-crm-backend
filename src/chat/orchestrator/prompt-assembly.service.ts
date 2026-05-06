import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeDocument } from '@prisma/client';

import { PromptService } from '../../prompt/prompt.service';
import { formatAttachmentBlock } from './attachment-formatter';
import { KNOWLEDGE_SEPARATOR, USER_CONTENT_LIMIT } from './pipeline.config';
import { BuiltPrompt, PromptInput, SystemBlock } from './types';

@Injectable()
export class PromptAssemblyService {
  private readonly logger = new Logger(PromptAssemblyService.name);

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

    this.logger.debug(`system[0] base_prompt | ${base.length} chars`);

    const dynamicParts: string[] = [];

    if (input.summary) {
      dynamicParts.push(`[CONVERSATION SUMMARY]\n${input.summary}`);
      this.logger.debug(`system[1] +summary | ${input.summary.length} chars`);
    }

    if (input.selectedKnowledge.length) {
      const docs = input.selectedKnowledge
        .map((k) => this.formatKnowledgeDoc(k))
        .join(KNOWLEDGE_SEPARATOR);
      dynamicParts.push(`[RELEVANT KNOWLEDGE]\n\n---\n\n${docs}\n\n---`);
      const titles = input.selectedKnowledge
        .map((k) => k.title ?? 'untitled')
        .join(', ');
      this.logger.debug(
        `system[1] +knowledge | ${input.selectedKnowledge.length} docs` +
          ` (${docs.length} chars) | titles: ${titles}`,
      );
    }

    if (dynamicParts.length) {
      const dynamicText = dynamicParts.join('\n\n');
      blocks.push({ type: 'text', text: dynamicText });
    }

    return blocks;
  }

  private buildMessages(input: PromptInput): BuiltPrompt['messages'] {
    const history = input.recentMessages.slice(0, -1).map((m) => ({
      role: m.role,
      content:
        m.role === 'user'
          ? `[USER]\n${m.content}`
          : `[ASSISTANT]\n${m.content}`,
    }));

    if (history.length > 0) {
      const historyChars = history.reduce((s, m) => s + m.content.length, 0);
      this.logger.debug(
        `messages history | ${history.length} msgs | ${historyChars} chars`,
      );
    }

    const userMessage = this.buildUserMessage(input);
    this.logger.log(`messages[-1] user | ${userMessage.length} chars`);

    return [...history, { role: 'user', content: userMessage }];
  }

  private buildUserMessage(input: PromptInput): string {
    const parts: string[] = [];

    if (input.domainContext.proposal?.vacancy) {
      const vacancy = input.domainContext.proposal.vacancy.slice(0, 3000);
      parts.push(`[CONTEXT: VACANCY]\n${vacancy}`);
      this.logger.debug(`user msg +vacancy | ${vacancy.length} chars`);
    }

    const safeContent = input.latestUserMessage.slice(0, USER_CONTENT_LIMIT);
    parts.push(`[LATEST USER MESSAGE]\n${safeContent}`);
    this.logger.debug(`user msg +user_content | ${safeContent.length} chars`);

    if (input.latestAttachments.length > 0) {
      const blocks = input.latestAttachments
        .map((a) => formatAttachmentBlock(a))
        .join('\n\n');
      parts.push(`[LATEST ATTACHMENTS]\n${blocks}`);
      const withText = input.latestAttachments.filter(
        (a) => a.textRepresentation,
      );
      this.logger.debug(
        `user msg +attachments | ${input.latestAttachments.length} files` +
          ` (${withText.length} with text)` +
          ` | ${blocks.length} chars` +
          ` | files: ${input.latestAttachments.map((a) => a.fileName).join(', ')}`,
      );
    }

    return parts.join('\n\n');
  }

  private formatKnowledgeDoc(doc: KnowledgeDocument): string {
    return `[DOCUMENT: ${doc.title ?? 'untitled'}]\n${doc.content}`;
  }
}
