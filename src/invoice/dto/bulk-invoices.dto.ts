import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

export const BULK_INVOICES_MAX = 50;

/** Shared body for both bulk-delete and bulk-download endpoints. */
export class BulkInvoicesDto {
  @ApiProperty({
    type: [String],
    description: `Invoice IDs. Max ${BULK_INVOICES_MAX} per call.`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_INVOICES_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];
}
