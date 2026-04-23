import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class UpdatePromptDto {
  @ApiProperty()
  @IsString()
  content: string;
}
