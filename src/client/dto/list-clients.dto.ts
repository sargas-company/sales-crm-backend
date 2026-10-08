import { ApiPropertyOptional } from '@nestjs/swagger';
import { ClientStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export enum ClientSortBy {
  firstName = 'firstName',
  company = 'company',
  email = 'email',
  phone = 'phone',
  status = 'status',
  clientSince = 'clientSince',
  updatedAt = 'updatedAt',
  createdAt = 'createdAt',
}

export enum ClientSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListClientsDto {
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

  @ApiPropertyOptional({ enum: ClientSortBy })
  @IsOptional()
  @IsEnum(ClientSortBy)
  sortBy?: ClientSortBy;

  @ApiPropertyOptional({
    enum: ClientSortDirection,
    default: ClientSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(ClientSortDirection)
  sortDirection?: ClientSortDirection;

  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive match against first/last name, company, email or phone.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;

  @ApiPropertyOptional({ enum: ClientStatus })
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  clientSinceFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  clientSinceTo?: string;
}
