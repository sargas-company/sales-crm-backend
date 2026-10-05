import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { CreateInvoiceLineItemDto } from './create-invoice-line-item.dto';
import { InvoiceCustomFieldDto } from './invoice-custom-field.dto';
import { IsDueDateAfterStart } from './due-date-after-start.validator';

export class CreateInvoiceDto {
  @ApiProperty({ example: 'uuid-of-counterparty' })
  @IsUUID()
  counterpartyId: string;

  @ApiPropertyOptional({ example: 'INVOICE' })
  @IsOptional()
  @IsString()
  header?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'INV-001' })
  @IsOptional()
  @IsString()
  number?: string;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: '2026-04-22' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({ example: '2026-05-22' })
  @IsOptional()
  @Transform(({ value }) => value || undefined)
  @IsDateString()
  @IsDueDateAfterStart()
  dueDate?: string;

  @ApiPropertyOptional({ example: 'NET 30' })
  @IsOptional()
  @IsString()
  paymentTerms?: string;

  @ApiPropertyOptional({ example: 'PO-123' })
  @IsOptional()
  @IsString()
  poNumber?: string;

  @ApiPropertyOptional({ example: 'Sargas Agency\n123 Main St' })
  @IsOptional()
  @IsString()
  fromValue?: string;

  @ApiPropertyOptional({ example: 'John Doe\n456 Client Ave' })
  @IsOptional()
  @IsString()
  toValue?: string;

  @ApiPropertyOptional({ example: '789 Ship St' })
  @IsOptional()
  @IsString()
  shipTo?: string;

  @ApiPropertyOptional({ example: 'Thank you for your business!' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ example: 'Payment due within 30 days.' })
  @IsOptional()
  @IsString()
  terms?: string;

  @ApiPropertyOptional({
    example: 10,
    description:
      'Tax rate expressed as a percent, 0..100. Frontend `utils.ts` always applies ' +
      '`subtotal * (tax / 100)` when `showTax` is true, so this field is a percent on ' +
      'the wire regardless of the UI`s `taxMode` toggle (the toggle is UI-only and is ' +
      'not persisted).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  tax?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discounts?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  shipping?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountPaid?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  showTax?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  showDiscounts?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  showShipping?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  showShipTo?: boolean;

  @ApiPropertyOptional({
    example: { to_title: 'Billing Address', unit_cost_header: 'Price' },
  })
  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;

  @ApiPropertyOptional({
    type: [InvoiceCustomFieldDto],
    example: [{ name: 'Project', value: 'Website Redesign' }],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => InvoiceCustomFieldDto)
  customFields?: InvoiceCustomFieldDto[];

  @ApiPropertyOptional({ type: [CreateInvoiceLineItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceLineItemDto)
  lineItems?: CreateInvoiceLineItemDto[];
}
