import { Module } from '@nestjs/common';

import { LinkedInIdeaController } from './linkedin-idea.controller';
import { LinkedInIdeaService } from './linkedin-idea.service';

@Module({
  controllers: [LinkedInIdeaController],
  providers: [LinkedInIdeaService],
  exports: [LinkedInIdeaService],
})
export class LinkedInIdeaModule {}
