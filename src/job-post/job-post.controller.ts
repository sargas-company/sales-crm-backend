import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { BulkDeleteJobPostsDto } from './dto/bulk-delete-job-posts.dto';
import { ConvertToProposalDto } from './dto/convert-to-proposal.dto';
import { JobPostStatsDto } from './dto/job-post-stats.dto';
import { ListJobPostsDto } from './dto/list-job-posts.dto';
import { JobPostService } from './job-post.service';

@ApiTags('Job Posts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('job-posts')
export class JobPostController {
  constructor(private readonly jobPostService: JobPostService) {}

  @Get()
  @RequirePermission('job_posts:view')
  @ApiOperation({
    summary: 'Get job posts with filters, sorting and pagination',
  })
  findAll(@Query() dto: ListJobPostsDto, @Request() req) {
    return this.jobPostService.findAll(dto, req.user.id);
  }

  @Get('stats')
  @RequirePermission('job_posts:view')
  @ApiOperation({ summary: 'Get job post statistics for a time period' })
  getStats(@Query() dto: JobPostStatsDto) {
    return this.jobPostService.getStats(dto);
  }

  @Get(':id')
  @RequirePermission('job_posts:view')
  @ApiOperation({ summary: 'Get job post by id with full AI response' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.jobPostService.findOne(id, req.user.id);
  }

  @Post(':id/view')
  @RequirePermission('job_posts:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark the job post as viewed by the current user (idempotent upsert; bumps viewedAt).',
  })
  markViewed(@Param('id') id: string, @Request() req) {
    return this.jobPostService.markViewed(id, req.user.id);
  }

  @Post(':id/to-proposal')
  @RequirePermission('job_posts:convert')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Convert job post to proposal' })
  convertToProposal(
    @Param('id') id: string,
    @Body() dto: ConvertToProposalDto,
    @Request() req,
  ) {
    return this.jobPostService.convertToProposal(id, dto, req.user.id);
  }

  @Delete(':id')
  @RequirePermission('job_posts:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete job post by id' })
  remove(@Param('id') id: string) {
    return this.jobPostService.remove(id);
  }

  @Post('bulk-delete')
  @RequirePermission('job_posts:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-delete job posts' })
  @ApiResponse({ status: 200, description: '{ deleted: number }' })
  bulkDelete(@Body() dto: BulkDeleteJobPostsDto) {
    return this.jobPostService.bulkRemove(dto.ids);
  }
}
