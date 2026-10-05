import { ApiProperty } from '@nestjs/swagger';
import { PromptType } from '@prisma/client';
import { IsEnum, IsString, Length } from 'class-validator';

export class CreatePromptDto {
  @ApiProperty({ enum: PromptType })
  @IsEnum(PromptType)
  type: PromptType;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title: string;

  @ApiProperty()
  @IsString()
  @Length(1, 100_000)
  content: string;
}
