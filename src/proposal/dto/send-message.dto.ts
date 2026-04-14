import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ example: 'Help me write an introduction for this proposal' })
  @IsString()
  @MinLength(1)
  content: string;
}
