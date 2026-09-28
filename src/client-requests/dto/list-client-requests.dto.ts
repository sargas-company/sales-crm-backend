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

export enum ClientRequestSortBy {
  name = 'name',
  email = 'email',
  phoneCountry = 'phoneCountry',
  status = 'status',
  createdAt = 'createdAt',
}

export enum ClientRequestSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListClientRequestsDto {
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

  @ApiPropertyOptional({ enum: ClientRequestSortBy })
  @IsOptional()
  @IsEnum(ClientRequestSortBy)
  sortBy?: ClientRequestSortBy;

  @ApiPropertyOptional({
    enum: ClientRequestSortDirection,
    default: ClientRequestSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(ClientRequestSortDirection)
  sortDirection?: ClientRequestSortDirection;

  @ApiPropertyOptional({
    description: 'Partial, case-insensitive match against contact name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;
}
