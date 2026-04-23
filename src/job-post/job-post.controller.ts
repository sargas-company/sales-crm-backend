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
import { ConvertToProposalDto } from './dto/convert-to-proposal.dto';
import { JobPostStatsDto } from './dto/job-post-stats.dto';
import { ListJobPostsDto } from './dto/list-job-posts.dto';
import { JobPostService } from './job-post.service';

@ApiTags('Job Posts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
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

  @Post(':id/to-proposal')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Convert job post to proposal' })
  @ApiResponse({ status: 201, description: 'Proposal created' })
  @ApiResponse({ status: 404, description: 'Job post not found' })
  @ApiResponse({
    status: 409,
    description: 'Proposal already exists for this job post',
  })
  convertToProposal(
    @Param('id') id: string,
    @Body() dto: ConvertToProposalDto,
    @Request() req,
  ) {
    return this.jobPostService.convertToProposal(id, dto, req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete job post by id' })
  @ApiResponse({ status: 204, description: 'Job post deleted' })
  @ApiResponse({ status: 404, description: 'Job post not found' })
  remove(@Param('id') id: string) {
    return this.jobPostService.remove(id);
  }
}
