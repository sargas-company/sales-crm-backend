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
import { BulkDeleteLinkedInPostsDto } from './dto/bulk-delete-linkedin-posts.dto';
import { CreateLinkedInPostDto } from './dto/create-linkedin-post.dto';
import { UpdateLinkedInPostDto } from './dto/update-linkedin-post.dto';
import { ListLinkedInPostsDto } from './dto/list-linkedin-posts.dto';
import { LinkedInPostService } from './linkedin-post.service';

@ApiTags('LinkedInPosts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('linkedin/posts')
export class LinkedInPostController {
  constructor(private readonly svc: LinkedInPostService) {}

  @Get()
  @RequirePermission('linkedin_posts:view')
  @ApiOperation({ summary: 'List LinkedIn posts (or calendar range)' })
  findAll(@Query() query: ListLinkedInPostsDto) {
    return this.svc.findAll(query);
  }

  @Get(':id')
  @RequirePermission('linkedin_posts:view')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @RequirePermission('linkedin_posts:create')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateLinkedInPostDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @RequirePermission('linkedin_posts:update')
  update(@Param('id') id: string, @Body() dto: UpdateLinkedInPostDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('linkedin_posts:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post('bulk-delete')
  @RequirePermission('linkedin_posts:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-delete LinkedIn posts' })
  bulkDelete(@Body() dto: BulkDeleteLinkedInPostsDto) {
    return this.svc.bulkRemove(dto.ids);
  }
}
