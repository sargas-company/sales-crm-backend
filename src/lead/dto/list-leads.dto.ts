import { ApiPropertyOptional } from '@nestjs/swagger';
import { LeadStatus, LeadTemperature } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
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
  company = 'company',
  clientType = 'clientType',
  status = 'status',
  temperature = 'temperature',
  rate = 'rate',
  location = 'location',
  email = 'email',
  phone = 'phone',
  repliedAt = 'repliedAt',
  updatedAt = 'updatedAt',
  createdAt = 'createdAt',
}

export enum LeadSortDirection {
  asc = 'asc',
  desc = 'desc',
}

const toArray = (v: unknown): string[] | undefined => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
};

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
      'Partial, case-insensitive match against first/last/company name, email, or phone.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional({
    enum: LeadStatus,
    isArray: true,
    description:
      'One or more statuses — accepted as repeated param or comma-separated string.',
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(LeadStatus, { each: true })
  @Type(() => String)
  status?: LeadStatus[];

  @ApiPropertyOptional({ enum: LeadTemperature, isArray: true })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(LeadTemperature, { each: true })
  @Type(() => String)
  temperature?: LeadTemperature[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  createdTo?: string;
}
