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
  @ApiOperation({ summary: 'Get all base knowledge entries' })
  @ApiResponse({ status: 200, description: 'List of entries ordered by date desc' })
  findAll() {
    return this.baseKnowledgeService.findAll();
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
