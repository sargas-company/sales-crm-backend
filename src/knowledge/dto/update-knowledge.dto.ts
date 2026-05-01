import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateKnowledgeDto {
  @ApiPropertyOptional({ example: 'How to write a great proposal' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @ApiPropertyOptional({ example: 'Full text content...' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  content?: string;

  @ApiPropertyOptional({ example: 'proposals' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  category?: string;
}
