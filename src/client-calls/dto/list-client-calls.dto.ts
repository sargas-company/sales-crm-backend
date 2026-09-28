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

export enum ClientCallSortBy {
  callTitle = 'callTitle',
  scheduledAt = 'scheduledAt',
  duration = 'duration',
  clientTimezone = 'clientTimezone',
  status = 'status',
  createdBy = 'createdBy',
  createdAt = 'createdAt',
}

export enum ClientCallSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListClientCallsDto {
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

  @ApiPropertyOptional({ enum: ClientCallSortBy })
  @IsOptional()
  @IsEnum(ClientCallSortBy)
  sortBy?: ClientCallSortBy;

  @ApiPropertyOptional({
    enum: ClientCallSortDirection,
    default: ClientCallSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(ClientCallSortDirection)
  sortDirection?: ClientCallSortDirection;

  @ApiPropertyOptional({
    description: 'Partial, case-insensitive match against callTitle.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;
}
