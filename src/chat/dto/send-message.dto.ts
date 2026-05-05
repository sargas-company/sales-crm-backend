import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6'] as const;

export class SendMessageDto {
  @ApiProperty({ example: 'Can you help me write a proposal?' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    description: 'Socket.IO socket id for streaming the response',
  })
  @IsString()
  @IsNotEmpty()
  socketId: string;

  @ApiPropertyOptional({ enum: ALLOWED_MODELS })
  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_MODELS)
  model?: string;
}
