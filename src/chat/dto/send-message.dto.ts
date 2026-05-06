import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6'] as const;

export class SendMessageDto {
  @ApiProperty({ example: 'Can you help me write a proposal?' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    description:
      'Deprecated: Socket.IO socket id (no longer used for AI streaming — events are sent to the proposal room)',
  })
  @IsOptional()
  @IsString()
  socketId?: string;

  @ApiPropertyOptional({ enum: ALLOWED_MODELS })
  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_MODELS)
  model?: string;
}
