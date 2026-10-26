import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateFolderDto {
  @ApiProperty({ example: 'Design assets' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: 'Parent folder id. Omit for a root folder.' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
