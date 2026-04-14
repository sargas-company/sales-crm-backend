import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CreateBaseKnowledgeDto } from './dto/create-base-knowledge.dto';
import { UpdateBaseKnowledgeDto } from './dto/update-base-knowledge.dto';
import { BaseKnowledgeService } from './base-knowledge.service';

@ApiTags('Base Knowledge')
@ApiBearerAuth('jwt')
@Controller('base-knowledge')
export class BaseKnowledgeController {
  constructor(private readonly baseKnowledgeService: BaseKnowledgeService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a base knowledge entry' })
  @ApiResponse({ status: 201, description: 'Entry created with embedding generated' })
  @ApiResponse({ status: 400, description: 'Title, description and category are required' })
  create(@Body() dto: CreateBaseKnowledgeDto) {
    return this.baseKnowledgeService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get paginated base knowledge entries' })
  @ApiQuery({ name: 'page', required: false, example: 1, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, example: 8, description: 'Items per page (default: 8)' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of entries ordered by date desc',
    schema: {
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id:          { type: 'string', example: 'uuid' },
              title:       { type: 'string', example: 'Polite Decline Template' },
              description: { type: 'string', example: 'Use this template to politely decline a client...' },
              category:    { type: 'string', example: 'templates' },
              createdAt:   { type: 'string', format: 'date-time' },
              updatedAt:   { type: 'string', format: 'date-time' },
            },
          },
        },
        total: { type: 'number', example: 25, description: 'Total number of entries. Pages = Math.ceil(total / limit)' },
      },
    },
  })
  findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 8,
  ) {
    return this.baseKnowledgeService.findAll(Number(page), Number(limit));
  }

  @Get('search')
  @ApiOperation({ summary: 'Semantic search in base knowledge' })
  @ApiQuery({ name: 'q', description: 'Search query text', example: 'polite decline client' })
  @ApiResponse({ status: 200, description: 'Top 5 most relevant entries' })
  search(@Query('q') q: string) {
    return this.baseKnowledgeService.searchRelevant(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a base knowledge entry by ID' })
  @ApiResponse({ status: 200, description: 'Entry found' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  findOne(@Param('id') id: string) {
    return this.baseKnowledgeService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a base knowledge entry' })
  @ApiResponse({ status: 200, description: 'Entry updated, embedding recalculated automatically' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  update(@Param('id') id: string, @Body() dto: UpdateBaseKnowledgeDto) {
    return this.baseKnowledgeService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a base knowledge entry' })
  @ApiResponse({ status: 204, description: 'Entry deleted' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  remove(@Param('id') id: string) {
    return this.baseKnowledgeService.remove(id);
  }
}
