import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
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
}
