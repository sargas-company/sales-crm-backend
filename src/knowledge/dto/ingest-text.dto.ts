import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class IngestTextDto {
  @ApiPropertyOptional({ example: 'How to write a great proposal' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({
    example: 'Full text content to ingest into the knowledge base...',
  })
  @IsString()
  @MinLength(1)
  content: string;

  @ApiPropertyOptional({ example: 'proposals', default: 'general' })
  @IsOptional()
  @IsString()
  category?: string;
}
