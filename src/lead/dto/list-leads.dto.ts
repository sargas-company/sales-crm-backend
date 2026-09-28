import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export enum LeadSortBy {
  number = 'number',
  firstName = 'firstName',
  clientType = 'clientType',
  status = 'status',
  rate = 'rate',
  location = 'location',
  repliedAt = 'repliedAt',
  createdAt = 'createdAt',
}

export enum LeadSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListLeadsDto {
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

  @ApiPropertyOptional({ enum: LeadSortBy })
  @IsOptional()
  @IsEnum(LeadSortBy)
  sortBy?: LeadSortBy;

  @ApiPropertyOptional({
    enum: LeadSortDirection,
    default: LeadSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(LeadSortDirection)
  sortDirection?: LeadSortDirection;

  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive match against first/last/company name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;
}
