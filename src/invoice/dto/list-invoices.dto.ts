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

export enum InvoiceSortBy {
  number = 'number',
  counterparty = 'counterparty',
  status = 'status',
  date = 'date',
  dueDate = 'dueDate',
  currency = 'currency',
  createdAt = 'createdAt',
}

export enum InvoiceSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class ListInvoicesDto {
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

  @ApiPropertyOptional({ enum: InvoiceSortBy })
  @IsOptional()
  @IsEnum(InvoiceSortBy)
  sortBy?: InvoiceSortBy;

  @ApiPropertyOptional({
    enum: InvoiceSortDirection,
    default: InvoiceSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(InvoiceSortDirection)
  sortDirection?: InvoiceSortDirection;

  @ApiPropertyOptional({
    description: 'Partial, case-insensitive match against invoice number.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;
}
