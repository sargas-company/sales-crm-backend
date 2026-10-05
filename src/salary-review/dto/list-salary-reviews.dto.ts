import { ApiPropertyOptional } from '@nestjs/swagger';
import { SalaryReviewResult } from '@prisma/client';
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

export enum SalaryReviewSortBy {
  scheduledDate = 'scheduledDate',
  effectiveDate = 'effectiveDate',
  createdAt = 'createdAt',
  result = 'result',
  employee = 'employee',
  previousRate = 'previousRate',
  newRate = 'newRate',
}

export enum SalaryReviewSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export enum SalaryReviewStatus {
  upcoming = 'upcoming',
  completed = 'completed',
  postponed = 'postponed',
}

export class ListSalaryReviewsDto {
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

  @ApiPropertyOptional({ enum: SalaryReviewSortBy })
  @IsOptional()
  @IsEnum(SalaryReviewSortBy)
  sortBy?: SalaryReviewSortBy;

  @ApiPropertyOptional({ enum: SalaryReviewSortDirection })
  @IsOptional()
  @IsEnum(SalaryReviewSortDirection)
  sortDirection?: SalaryReviewSortDirection;

  @ApiPropertyOptional()
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
  employeeId?: string;

  @ApiPropertyOptional({ enum: SalaryReviewResult })
  @IsOptional()
  @IsEnum(SalaryReviewResult)
  result?: SalaryReviewResult;

  @ApiPropertyOptional({ enum: SalaryReviewStatus })
  @IsOptional()
  @IsEnum(SalaryReviewStatus)
  status?: SalaryReviewStatus;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;
}
