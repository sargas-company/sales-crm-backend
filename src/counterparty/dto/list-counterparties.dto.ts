import { ApiPropertyOptional } from '@nestjs/swagger';
import { CounterpartyType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export enum CounterpartySortBy {
  firstName = 'firstName',
  type = 'type',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
}

export enum CounterpartySortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListCounterpartiesDto {
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

  @ApiPropertyOptional({ enum: CounterpartySortBy })
  @IsOptional()
  @IsEnum(CounterpartySortBy)
  sortBy?: CounterpartySortBy;

  @ApiPropertyOptional({
    enum: CounterpartySortDirection,
    default: CounterpartySortDirection.desc,
  })
  @IsOptional()
  @IsEnum(CounterpartySortDirection)
  sortDirection?: CounterpartySortDirection;

  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive match against first or last name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional({
    enum: CounterpartyType,
    description:
      'Restrict the result to a single counterparty type (e.g. only `client` rows for the Project form picker). Omit to include every type the caller is allowed to see.',
  })
  @IsOptional()
  @IsEnum(CounterpartyType)
  type?: CounterpartyType;
}
