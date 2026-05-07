import { Module } from '@nestjs/common';

import { TranslationController } from './translation.controller';
import { TranslationService } from './translation.service';
import { DeeplProvider } from './providers/deepl.provider';

@Module({
  controllers: [TranslationController],
  providers: [TranslationService, DeeplProvider],
  exports: [TranslationService],
})
export class TranslationModule {}
