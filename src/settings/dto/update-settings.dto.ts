import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class UpdateSettingsDto {
  @ApiProperty({
    example: 'You are an assistant that helps write professional proposals for a software agency.',
  })
  @IsString()
  systemPrompt: string;
}
