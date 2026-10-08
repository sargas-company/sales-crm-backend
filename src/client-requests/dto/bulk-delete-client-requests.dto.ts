import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

/** Mirrors the ProjectReports bulk-delete contract: 1..500 unique
 *  UUIDs. The service treats stale ids as a no-op; `deleted` in the
 *  response reports how many rows actually matched. */
export class BulkDeleteClientRequestsDto {
  @ApiProperty({ type: [String], description: 'ClientRequest IDs to delete' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];
}
