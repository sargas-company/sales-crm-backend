import { ApiPropertyOptional } from '@nestjs/swagger';
import { CounterpartyType, InvoiceStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
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

/* Shared filter base — the same set of filters feeds both the list
 * endpoint and the stats endpoint (`/invoices/stats`), so KPI cards
 * always reflect the active list filter. */
export class InvoiceFiltersDto {
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

  @ApiPropertyOptional({ enum: InvoiceStatus })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional({ description: 'Counterparty UUID.' })
  @IsOptional()
  @IsUUID()
  counterpartyId?: string;

  @ApiPropertyOptional({
    enum: CounterpartyType,
    description:
      'Scopes to invoices whose counterparty.type matches. Visible-types scope policy still applies on top.',
  })
  @IsOptional()
  @IsEnum(CounterpartyType)
  type?: CounterpartyType;

  @ApiPropertyOptional({ description: 'Issue-date lower bound, inclusive (YYYY-MM-DD or ISO).' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Issue-date upper bound, inclusive (YYYY-MM-DD or ISO).' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}

export class ListInvoicesDto extends InvoiceFiltersDto {
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
}
