import { Module } from '@nestjs/common';

import { LinkedInPostController } from './linkedin-post.controller';
import { LinkedInPostService } from './linkedin-post.service';

@Module({
  controllers: [LinkedInPostController],
  providers: [LinkedInPostService],
  exports: [LinkedInPostService],
})
export class LinkedInPostModule {}
