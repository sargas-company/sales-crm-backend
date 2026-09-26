import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PromptController } from './prompt.controller';
import { PromptService } from './prompt.service';

@Module({
  imports: [AuthModule],
  controllers: [PromptController],
  providers: [PromptService],
  exports: [PromptService],
})
export class PromptModule {}
