import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IngestTextDto } from './dto/ingest-text.dto';
import { ListKnowledgeDto } from './dto/list-knowledge.dto';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeQueryService } from './knowledge-query.service';

@ApiTags('Knowledge')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(
    private readonly ingestionService: KnowledgeIngestionService,
    private readonly queryService: KnowledgeQueryService,
  ) {}

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

  @Get()
  @ApiOperation({ summary: 'List knowledge documents with pagination' })
  @ApiResponse({
    status: 200,
    description: 'Returns paginated list and total count',
  })
  findAll(@Query() dto: ListKnowledgeDto) {
    return this.queryService.findAll(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a knowledge document by ID' })
  @ApiResponse({ status: 200, description: 'Returns the knowledge document' })
  @ApiResponse({ status: 404, description: 'Not found' })
  findById(@Param('id') id: string) {
    return this.queryService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a knowledge document' })
  @ApiResponse({ status: 200, description: 'Returns updated document' })
  @ApiResponse({ status: 404, description: 'Not found' })
  update(@Param('id') id: string, @Body() dto: UpdateKnowledgeDto) {
    return this.queryService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a knowledge document' })
  @ApiResponse({ status: 204, description: 'Document deleted' })
  @ApiResponse({ status: 404, description: 'Not found' })
  remove(@Param('id') id: string) {
    return this.queryService.remove(id);
  }
}
