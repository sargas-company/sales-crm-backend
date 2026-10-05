import { ApiPropertyOptional } from '@nestjs/swagger';
import { TimeOffType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

export enum TimeOffSortBy {
  startDate = 'startDate',
  endDate = 'endDate',
  type = 'type',
  workingDays = 'workingDays',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
}

export enum TimeOffSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListTimeOffDto {
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

  @ApiPropertyOptional({ enum: TimeOffSortBy })
  @IsOptional()
  @IsEnum(TimeOffSortBy)
  sortBy?: TimeOffSortBy;

  @ApiPropertyOptional({
    enum: TimeOffSortDirection,
    default: TimeOffSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(TimeOffSortDirection)
  sortDirection?: TimeOffSortDirection;

  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive match against employee first/last name or note.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional({ enum: TimeOffType })
  @IsOptional()
  @IsEnum(TimeOffType)
  type?: TimeOffType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Calendar year (records overlapping it).' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive lower bound.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive upper bound.' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
