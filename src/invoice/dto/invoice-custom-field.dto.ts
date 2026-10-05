import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * Shape mirrors `InvoiceCustomField` in
 * `sales-crm-frontend/src/store/invoices/invoicesApi.ts` so the wire
 * contract stays identical (`{ name, value }`).
 */
export class InvoiceCustomFieldDto {
  @ApiProperty({ example: 'Project' })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({ example: 'Website Redesign' })
  @IsString()
  @Length(0, 2000)
  value!: string;
}
