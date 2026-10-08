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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { BulkDeleteLinkedInIdeasDto } from './dto/bulk-delete-linkedin-ideas.dto';
import { CreateLinkedInIdeaDto } from './dto/create-linkedin-idea.dto';
import { UpdateLinkedInIdeaDto } from './dto/update-linkedin-idea.dto';
import { ListLinkedInIdeasDto } from './dto/list-linkedin-ideas.dto';
import { LinkedInIdeaService } from './linkedin-idea.service';

@ApiTags('LinkedInIdeas')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('linkedin/ideas')
export class LinkedInIdeaController {
  constructor(private readonly svc: LinkedInIdeaService) {}

  @Get()
  @RequirePermission('linkedin_ideas:view')
  @ApiOperation({ summary: 'List LinkedIn ideas' })
  findAll(@Query() query: ListLinkedInIdeasDto) {
    return this.svc.findAll(query);
  }

  @Get(':id')
  @RequirePermission('linkedin_ideas:view')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @RequirePermission('linkedin_ideas:create')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateLinkedInIdeaDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @RequirePermission('linkedin_ideas:update')
  update(@Param('id') id: string, @Body() dto: UpdateLinkedInIdeaDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('linkedin_ideas:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post('bulk-delete')
  @RequirePermission('linkedin_ideas:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-delete LinkedIn ideas' })
  bulkDelete(@Body() dto: BulkDeleteLinkedInIdeasDto) {
    return this.svc.bulkRemove(dto.ids);
  }
}
