import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { LinkedInIdeaPriority, LinkedInIdeaStatus } from '@prisma/client';

export enum LinkedInIdeaSortBy {
  title = 'title',
  status = 'status',
  priority = 'priority',
  plannedDate = 'plannedDate',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
}

export enum SortDir {
  asc = 'asc',
  desc = 'desc',
}

export class ListLinkedInIdeasDto {
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
  @Max(100)
  limit?: number = 25;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: LinkedInIdeaStatus })
  @IsOptional()
  @IsEnum(LinkedInIdeaStatus)
  status?: LinkedInIdeaStatus;

  @ApiPropertyOptional({ enum: LinkedInIdeaPriority })
  @IsOptional()
  @IsEnum(LinkedInIdeaPriority)
  priority?: LinkedInIdeaPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ enum: LinkedInIdeaSortBy, default: LinkedInIdeaSortBy.updatedAt })
  @IsOptional()
  @IsEnum(LinkedInIdeaSortBy)
  sortBy?: LinkedInIdeaSortBy = LinkedInIdeaSortBy.updatedAt;

  @ApiPropertyOptional({ enum: SortDir, default: SortDir.desc })
  @IsOptional()
  @IsEnum(SortDir)
  sortDir?: SortDir = SortDir.desc;
}
