import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

import {
  JobPostDecision,
  JobPostPriority,
  JobPostStatus,
} from '@prisma/client';

export enum JobPostSortBy {
  createdAt = 'createdAt',
  matchScore = 'matchScore',
  title = 'title',
  status = 'status',
  budget = 'budget',
  location = 'location',
  totalSpent = 'totalSpent',
  avgRatePaid = 'avgRatePaid',
  hireRate = 'hireRate',
  scanner = 'scanner',
  processedAt = 'processedAt',
}

export enum JobPostSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListJobPostsDto {
  @ApiPropertyOptional({ enum: JobPostDecision })
  @IsOptional()
  @IsEnum(JobPostDecision)
  decision?: JobPostDecision;

  @ApiPropertyOptional({ enum: JobPostPriority })
  @IsOptional()
  @IsEnum(JobPostPriority)
  priority?: JobPostPriority;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(100)
  minScore?: number;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(100)
  maxScore?: number;

  @ApiPropertyOptional({
    enum: JobPostSortBy,
    default: JobPostSortBy.createdAt,
  })
  @IsOptional()
  @IsEnum(JobPostSortBy)
  sortBy?: JobPostSortBy = JobPostSortBy.createdAt;

  @ApiPropertyOptional({
    enum: JobPostSortDirection,
    default: JobPostSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(JobPostSortDirection)
  sortDirection?: JobPostSortDirection = JobPostSortDirection.desc;

  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive match against the job post title.',
    example: 'react',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number = 0;

  @ApiPropertyOptional({
    description:
      'When omitted, returns posts in ANY status. Pass a specific enum value to narrow.',
    enum: JobPostStatus,
  })
  @IsOptional()
  @IsEnum(JobPostStatus)
  status?: JobPostStatus;

  @ApiPropertyOptional({ example: '2026-04-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({ example: '2026-04-30T23:59:59.000Z' })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({
    description:
      'Filter by the current user\'s view state. "viewed" returns only posts the user has opened; "unviewed" returns only posts they have not. Omit for both.',
    enum: ['viewed', 'unviewed'],
  })
  @IsOptional()
  @IsEnum(['viewed', 'unviewed'] as unknown as object)
  viewed?: 'viewed' | 'unviewed';

  @ApiPropertyOptional({
    description:
      'Case-insensitive substring match against the normalised `country` field; falls through to the legacy `location` string so legacy ingestions are searchable too.',
    example: 'germ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  country?: string;
}
