import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';

export class BulkDeleteDto {
  @ApiPropertyOptional({ type: [String], description: 'Folder ids to delete.' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  folderIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'File ids to delete.' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  fileIds?: string[];
}

export class BulkMoveDto {
  @ApiPropertyOptional({ type: [String], description: 'Folder ids to move.' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  folderIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'File ids to move.' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  fileIds?: string[];

  @ApiProperty({
    nullable: true,
    description: 'Destination folder id, or null for root.',
  })
  @IsOptional()
  @IsString()
  destinationFolderId: string | null;
}
