import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateBaseKnowledgeDto {
  @ApiProperty({ example: 'Polite Decline Template' })
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({
    example: 'Use this template to politely decline a client while keeping a good tone for the future.',
  })
  @IsString()
  @MinLength(1)
  description: string;

  @ApiProperty({ example: 'templates' })
  @IsString()
  @MinLength(1)
  category: string;
}
