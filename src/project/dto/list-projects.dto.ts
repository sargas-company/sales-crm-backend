import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export enum ProjectSortBy {
  name = 'name',
  status = 'status',
  startDate = 'startDate',
  endDate = 'endDate',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
}

export enum ProjectSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListProjectsDto {
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

  @ApiPropertyOptional({ enum: ProjectSortBy })
  @IsOptional()
  @IsEnum(ProjectSortBy)
  sortBy?: ProjectSortBy;

  @ApiPropertyOptional({
    enum: ProjectSortDirection,
    default: ProjectSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(ProjectSortDirection)
  sortDirection?: ProjectSortDirection;

  @ApiPropertyOptional({
    description: 'Partial, case-insensitive match against project name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional({ description: 'Filter by client counterparty' })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
