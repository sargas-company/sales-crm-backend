import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import { AnthropicService } from '../../anthropic/anthropic.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CONTENT_FILTER_DOC_LIMIT,
  CONTENT_FILTER_MODEL,
  TITLE_FILTER_MODEL,
} from './pipeline.config';

const TITLE_FILTER_PROMPT = `You are a knowledge filter.

Given a job vacancy and a list of knowledge documents (ID + title), select documents that MIGHT be relevant for writing a response or proposal for this vacancy.

Be inclusive at this stage — if in doubt, include it. A second filter will do the precise selection.

Return ONLY a JSON array of string IDs.
Examples: ["id1", "id2"] or []

No text outside JSON. No explanations.`;

const CONTENT_FILTER_PROMPT = `You are a knowledge relevance judge.

Given a job vacancy and knowledge documents (with full content), select ONLY documents that would genuinely help write a better response or proposal for this specific vacancy.

Be selective — only include documents that directly add value.

Return ONLY a JSON array of string IDs.
Examples: ["id1", "id2"] or []

No text outside JSON. No explanations.`;

type TitleDoc = { id: string; title: string | null };
type FullDoc = { id: string; title: string | null; content: string };

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropicService: AnthropicService,
  ) {}

  async getSnippets(vacancyContext: string): Promise<string[]> {
    // Stage 1 — title filter
    const allDocs = await this.fetchAllTitles();

    if (allDocs.length === 0) {
      this.logger.warn('knowledge base is empty, skipping retrieval');
      return [];
    }

    this.logger.log(`stage1 | total docs=${allDocs.length}`);

    const candidateIds = await this.runTitleFilter(allDocs, vacancyContext);

    if (candidateIds.length === 0) {
      this.logger.warn(
        `stage1 | 0 candidates selected from ${allDocs.length} docs`,
      );
      return [];
    }

    this.logger.log(
      `stage1 | selected ${candidateIds.length}/${allDocs.length} candidates: [${candidateIds.join(', ')}]`,
    );

    // Stage 2 — content filter
    const candidateDocs = await this.fetchFullDocs(candidateIds);

    this.logger.log(`stage2 | fetched ${candidateDocs.length} full docs`);

    const finalIds = await this.runContentFilter(candidateDocs, vacancyContext);

    if (finalIds.length === 0) {
      this.logger.warn(
        `stage2 | 0 docs passed content filter from ${candidateDocs.length} candidates`,
      );
      return [];
    }

    this.logger.log(
      `stage2 | final selection ${finalIds.length}/${candidateDocs.length}: [${finalIds.join(', ')}]`,
    );

    const finalDocs = candidateDocs.filter((d) => finalIds.includes(d.id));
    return finalDocs.map(
      (d) => `[DOCUMENT: ${d.title ?? 'untitled'}]\n${d.content}`,
    );
  }

  private fetchAllTitles(): Promise<TitleDoc[]> {
    return this.prisma.knowledgeDocument.findMany({
      select: { id: true, title: true },
    });
  }

  private fetchFullDocs(ids: string[]): Promise<FullDoc[]> {
    return this.prisma.knowledgeDocument.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, content: true },
    });
  }

  private async runTitleFilter(
    docs: TitleDoc[],
    vacancyContext: string,
  ): Promise<string[]> {
    const docList = docs
      .map((d) => `- ID: ${d.id} | Title: ${d.title ?? '(no title)'}`)
      .join('\n');

    const userContent = `Vacancy:\n${vacancyContext.slice(0, 1000)}\n\nDocuments:\n${docList}`;

    try {
      const response = await this.anthropicService.client.messages.create({
        model: TITLE_FILTER_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system: TITLE_FILTER_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');

      const ids = this.parseIds(
        text,
        docs.map((d) => d.id),
      );

      this.logger.log(`stage1 LLM response parsed | ids=${ids.join(', ')}`);
      return ids;
    } catch (error) {
      this.logger.error(
        'stage1 API call failed',
        error instanceof Error ? error.stack : String(error),
      );
      return [];
    }
  }

  private async runContentFilter(
    docs: FullDoc[],
    vacancyContext: string,
  ): Promise<string[]> {
    const docList = docs
      .map((d) => {
        const content = d.content.slice(0, CONTENT_FILTER_DOC_LIMIT);
        return `[DOCUMENT ID: ${d.id}]\nTitle: ${d.title ?? '(no title)'}\n\n${content}`;
      })
      .join('\n\n---\n\n');

    const userContent = `Vacancy:\n${vacancyContext.slice(0, 1000)}\n\nDocuments:\n\n${docList}`;

    try {
      const response = await this.anthropicService.client.messages.create({
        model: CONTENT_FILTER_MODEL,
        max_tokens: 256,
        temperature: 0,
        system: CONTENT_FILTER_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');

      const ids = this.parseIds(
        text,
        docs.map((d) => d.id),
      );

      this.logger.log(`stage2 LLM response parsed | ids=${ids.join(', ')}`);
      return ids;
    } catch (error) {
      this.logger.error(
        'stage2 API call failed',
        error instanceof Error ? error.stack : String(error),
      );
      return [];
    }
  }

  private parseIds(text: string, validIds: string[]): string[] {
    const cleaned = text
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```$/m, '')
      .trim();

    let parsed: unknown;

    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) {
        this.logger.warn(
          `parseIds: no JSON array found | raw="${cleaned.slice(0, 200)}"`,
        );
        return [];
      }
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        this.logger.warn(
          `parseIds: extracted array is invalid JSON | raw="${match[0].slice(0, 200)}"`,
        );
        return [];
      }
    }

    if (!Array.isArray(parsed)) {
      this.logger.warn(`parseIds: parsed value is not an array`);
      return [];
    }

    return parsed.filter(
      (id): id is string => typeof id === 'string' && validIds.includes(id),
    );
  }
}
