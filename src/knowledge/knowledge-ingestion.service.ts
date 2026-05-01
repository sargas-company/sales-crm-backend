import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { CONTENT_MAX_LENGTH } from '../chat/orchestrator/pipeline.config';
import { PrismaService } from '../prisma/prisma.service';

export interface IngestResult {
  documentId: string;
}

@Injectable()
export class KnowledgeIngestionService {
  private readonly logger = new Logger(KnowledgeIngestionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingestText(input: {
    title?: string;
    content: string;
    category?: string;
  }): Promise<IngestResult> {
    const safeContent = input.content.trim().slice(0, CONTENT_MAX_LENGTH);

    if (!safeContent) {
      throw new BadRequestException('Content cannot be empty');
    }

    const document = await this.prisma.knowledgeDocument.create({
      data: {
        title: input.title ?? null,
        category: input.category ?? 'general',
        content: safeContent,
      },
    });

    this.logger.log(
      `document ${document.id} ingested (${safeContent.length} chars)`,
    );

    return { documentId: document.id };
  }
}
