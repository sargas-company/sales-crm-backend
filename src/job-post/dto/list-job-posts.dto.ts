import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
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
    enum: JobPostStatus,
    default: JobPostStatus.PROCESSED,
  })
  @IsOptional()
  @IsEnum(JobPostStatus)
  status?: JobPostStatus = JobPostStatus.PROCESSED;

  @ApiPropertyOptional({ example: '2026-04-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({ example: '2026-04-30T23:59:59.000Z' })
  @IsOptional()
  @IsDateString()
  createdTo?: string;
}
