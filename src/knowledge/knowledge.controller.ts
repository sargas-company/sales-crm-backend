import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IngestTextDto } from './dto/ingest-text.dto';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';

@ApiTags('Knowledge')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly ingestionService: KnowledgeIngestionService) {}

  @Post('ingest')
  @ApiOperation({ summary: 'Ingest plain text into the knowledge base' })
  @ApiResponse({
    status: 201,
    description: 'Returns documentId and number of chunks created',
  })
  ingest(@Body() dto: IngestTextDto) {
    return this.ingestionService.ingestText({
      title: dto.title,
      content: dto.content,
      category: dto.category,
    });
  }
}
