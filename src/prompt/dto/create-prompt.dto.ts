import { ApiProperty } from '@nestjs/swagger';
import { PromptType } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';

export class CreatePromptDto {
  @ApiProperty({ enum: PromptType })
  @IsEnum(PromptType)
  type: PromptType;

  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsString()
  content: string;
}
