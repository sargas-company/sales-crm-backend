import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
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
}
