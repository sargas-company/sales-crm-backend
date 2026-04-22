import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JobPostStatsDto } from './dto/job-post-stats.dto';
import { ListJobPostsDto } from './dto/list-job-posts.dto';
import { JobPostService } from './job-post.service';

@ApiTags('Job Posts')
@Controller('job-posts')
export class JobPostController {
  constructor(private readonly jobPostService: JobPostService) {}

  @Get()
  @ApiOperation({
    summary: 'Get job posts with filters, sorting and pagination',
  })
  findAll(@Query() dto: ListJobPostsDto) {
    return this.jobPostService.findAll(dto);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get job post statistics for a time period' })
  getStats(@Query() dto: JobPostStatsDto) {
    return this.jobPostService.getStats(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get job post by id with full AI response' })
  findOne(@Param('id') id: string) {
    return this.jobPostService.findOne(id);
  }
}
