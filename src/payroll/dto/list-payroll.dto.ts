import { ApiPropertyOptional } from '@nestjs/swagger';
import { PayrollStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum PayrollSortBy {
  employee = 'employee',
  baseSalary = 'baseSalary',
  totalAccrued = 'totalAccrued',
  companyCost = 'companyCost',
  remainingToPay = 'remainingToPay',
  bonusAmount = 'bonusAmount',
  payoneerFee = 'payoneerFee',
  status = 'status',
  createdAt = 'createdAt',
}

export enum PayrollSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListPayrollDto {
  @ApiPropertyOptional({ example: 2026 })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiPropertyOptional({ example: 9 })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @ApiPropertyOptional({ enum: PayrollSortBy })
  @IsOptional()
  @IsEnum(PayrollSortBy)
  sortBy?: PayrollSortBy;

  @ApiPropertyOptional({ enum: PayrollSortDirection })
  @IsOptional()
  @IsEnum(PayrollSortDirection)
  sortDirection?: PayrollSortDirection;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional({ enum: PayrollStatus })
  @IsOptional()
  @IsEnum(PayrollStatus)
  status?: PayrollStatus;
}
