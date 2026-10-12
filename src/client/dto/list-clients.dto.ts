import { ApiPropertyOptional } from '@nestjs/swagger';
import { ClientStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/* `clientSince` sort option intentionally removed (rev-5 2026-10-12):
 * the field left the UI; the list no longer surfaces it as a column
 * or filter. The DB column stays. */
export enum ClientSortBy {
  number = 'number',
  firstName = 'firstName',
  company = 'company',
  email = 'email',
  phone = 'phone',
  status = 'status',
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

  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive match on Client.location. Accepts a country name, city, or any fragment the autocomplete produced.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  location?: string;
}
