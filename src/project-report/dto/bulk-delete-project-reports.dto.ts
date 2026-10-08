import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * Bulk delete payload. The hard cap of 500 ids per request matches a
 * single DataTable page's ceiling with a generous safety margin —
 * callers that need to clear more should paginate the requests
 * themselves rather than hold one giant transaction open.
 */
export class BulkDeleteProjectReportsDto {
  @ApiProperty({ type: [String], description: 'ProjectReport IDs to delete' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];
}
