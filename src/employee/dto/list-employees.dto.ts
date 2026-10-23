import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum EmployeeSortBy {
  firstName = 'firstName',
  lastName = 'lastName',
  email = 'email',
  status = 'status',
  hiredAt = 'hiredAt',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
  // Sorts by the employee's CURRENT compensation rate — most recent
  // EmployeeCompensationRate whose effectiveDate has already arrived,
  // normalised to a monthly figure (hourly * 160). Rows with no
  // compensation history are treated as 0 and sorted last. Handled
  // in-memory because Prisma can't orderBy a nested row's field.
  salary = 'salary',
}

export enum EmployeeSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListEmployeesDto {
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

  @ApiPropertyOptional({ enum: EmployeeSortBy })
  @IsOptional()
  @IsEnum(EmployeeSortBy)
  sortBy?: EmployeeSortBy;

  @ApiPropertyOptional({
    enum: EmployeeSortDirection,
    default: EmployeeSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(EmployeeSortDirection)
  sortDirection?: EmployeeSortDirection;

  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive match against first name, last name or email.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional({ enum: EmployeeStatus })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional({
    description: 'Position catalogue UUID — matches employees whose positions include this id.',
  })
  @IsOptional()
  @IsUUID()
  position?: string;

  @ApiPropertyOptional({
    description:
      'Calendar month (1 = Jan, 12 = Dec). Filters employees whose dateOfBirth falls in this month, regardless of year.',
    minimum: 1,
    maximum: 12,
  })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(12)
  birthdayMonth?: number;

  /** YYYY-MM filter — "employees payable for this month".
   *
   * An employee is considered payable for month M when they were
   * ACTIVE at any point during M:
   *   • `hiredAt` is null OR `hiredAt <= last day of M`, AND
   *   • `terminatedAt` is null OR `terminatedAt >= first day of M`.
   *
   * So someone terminated on the 15th of M still appears in that
   * month's payroll (they worked days 1–14), and someone rehired
   * mid-month appears starting from that month onwards. */
  @ApiPropertyOptional({
    description:
      'YYYY-MM — filters to employees who were active at any point in that calendar month.',
    example: '2026-10',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'activeInMonth must be in YYYY-MM format with month 01-12',
  })
  activeInMonth?: string;
}
