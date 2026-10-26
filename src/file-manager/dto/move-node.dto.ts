import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class MoveNodeDto {
  @ApiPropertyOptional({
    description:
      'Target parent folder id. Omit (or pass null) to move the node to the root.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  targetFolderId?: string | null;
}
