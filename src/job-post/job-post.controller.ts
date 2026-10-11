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
import { BulkJobPostIdsDto } from './dto/bulk-job-post-ids.dto';
import { ConvertToProposalDto } from './dto/convert-to-proposal.dto';
import { EnableAnalysisDto } from './dto/enable-analysis.dto';
import { PreviewEnableAnalysisDto } from './dto/preview-enable-analysis.dto';
import { JobPostNeighborDto } from './dto/job-post-neighbor.dto';
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

  @Get('queue-stats')
  @RequirePermission('job_posts:view')
  @ApiOperation({
    summary:
      'Live counters for the scanner panel. Returns Postgres-side (backlog/pending/processing/failed) and BullMQ-side (waiting/delayed/active/paused/prioritized) counts plus the current analysisEnabled flag.',
  })
  getQueueStats() {
    return this.jobPostService.getQueueStats();
  }

  @Get('analysis-preview')
  @RequirePermission('settings_scanner:update')
  @ApiOperation({
    summary:
      'Preview the effect of a Resume-AI strategy without changing any state. Returns to-analyse / to-skip counts and a cost range for the Haiku + Sonnet work.',
  })
  previewAnalysis(@Query() dto: PreviewEnableAnalysisDto) {
    return this.jobPostService.previewEnableAnalysis(dto);
  }

  @Get('city-suggestions')
  @RequirePermission('job_posts:view')
  @ApiOperation({
    summary:
      'Autocomplete suggestions for the Country filter: distinct city + country pairs seen in JobPost rows, filtered by a case-insensitive substring on city.',
  })
  citySuggestions(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Math.max(1, Math.min(30, Number(limit) || 10));
    return this.jobPostService.citySuggestions(q?.trim() || undefined, parsedLimit);
  }

  @Get(':id')
  @RequirePermission('job_posts:view')
  @ApiOperation({ summary: 'Get job post by id with full AI response' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.jobPostService.findOne(id, req.user.id);
  }

  @Get(':id/neighbor')
  @RequirePermission('job_posts:view')
  @ApiOperation({
    summary:
      'Keyset Prev/Next for the detail page. Resolves the single previous or next JobPost in the current filter+sort WITHOUT offset pagination; stable against rows disappearing from the Unviewed filter after markViewed.',
  })
  findNeighbor(
    @Param('id') id: string,
    @Query() dto: JobPostNeighborDto,
    @Request() req,
  ) {
    return this.jobPostService.findNeighbor(
      id,
      req.user.id,
      dto.direction,
      dto,
    );
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

  @Post('enable-analysis')
  @RequirePermission('settings_scanner:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resume AI analysis with a backlog strategy (all / recent / new_posts_only / cancel). Flips scanner.analysisEnabled on and applies the strategy to the BACKLOG snapshot in one DB transaction.',
  })
  enableAnalysis(@Body() dto: EnableAnalysisDto) {
    return this.jobPostService.enableAnalysis(dto);
  }

  @Post('analyze')
  @RequirePermission('settings_scanner:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Bulk re-queue: NEW/SKIPPED/FAILED → NEW+PENDING. PROCESSED/PROCESSING are never touched.',
  })
  bulkAnalyze(@Body() dto: BulkJobPostIdsDto) {
    return this.jobPostService.bulkAnalyze(dto.ids);
  }

  @Post('skip')
  @RequirePermission('settings_scanner:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk skip: NEW → SKIPPED. Other statuses are left alone.',
  })
  bulkSkip(@Body() dto: BulkJobPostIdsDto) {
    return this.jobPostService.bulkSkip(dto.ids);
  }
}
