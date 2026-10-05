import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { LinkedInPostFormat, LinkedInPostStatus } from '@prisma/client';

export enum LinkedInPostSortBy {
  internalTitle = 'internalTitle',
  status = 'status',
  format = 'format',
  scheduledAt = 'scheduledAt',
  publishedAt = 'publishedAt',
  impressions = 'impressions',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
}

export enum SortDir {
  asc = 'asc',
  desc = 'desc',
}

export class ListLinkedInPostsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(({ value }) => (value == null ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Transform(({ value }) => (value == null ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 25;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({ enum: LinkedInPostStatus })
  @IsOptional()
  @IsEnum(LinkedInPostStatus)
  status?: LinkedInPostStatus;

  @ApiPropertyOptional({ enum: LinkedInPostFormat })
  @IsOptional()
  @IsEnum(LinkedInPostFormat)
  format?: LinkedInPostFormat;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  language?: string;

  /**
   * Calendar-view range: return every post whose scheduledAt OR
   * publishedAt falls between these two dates (inclusive on the
   * start, exclusive on the end).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  rangeStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  rangeEnd?: string;

  @ApiPropertyOptional({ enum: LinkedInPostSortBy, default: LinkedInPostSortBy.updatedAt })
  @IsOptional()
  @IsEnum(LinkedInPostSortBy)
  sortBy?: LinkedInPostSortBy = LinkedInPostSortBy.updatedAt;

  @ApiPropertyOptional({ enum: SortDir, default: SortDir.desc })
  @IsOptional()
  @IsEnum(SortDir)
  sortDir?: SortDir = SortDir.desc;
}
