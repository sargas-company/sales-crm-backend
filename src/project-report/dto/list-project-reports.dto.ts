import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export enum ProjectReportSortBy {
  reportDate = 'reportDate',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
  hours = 'hours',
  source = 'source',
}

export enum ProjectReportSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListProjectReportsDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ enum: ProjectReportSortBy })
  @IsOptional()
  @IsEnum(ProjectReportSortBy)
  sortBy?: ProjectReportSortBy;

  @ApiPropertyOptional({
    enum: ProjectReportSortDirection,
    default: ProjectReportSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(ProjectReportSortDirection)
  sortDirection?: ProjectReportSortDirection;

  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive match against report content.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive lower bound.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive upper bound.' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
