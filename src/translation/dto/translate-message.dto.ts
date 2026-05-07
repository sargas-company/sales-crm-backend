import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { TranslationLanguage } from '@prisma/client';

export class TranslateMessageDto {
  @ApiProperty({ enum: TranslationLanguage, example: TranslationLanguage.UK })
  @IsEnum(TranslationLanguage)
  targetLanguage: TranslationLanguage;
}
