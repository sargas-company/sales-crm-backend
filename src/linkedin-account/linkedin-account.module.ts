import { Module } from '@nestjs/common';

import { LinkedInAccountController } from './linkedin-account.controller';
import { LinkedInAccountService } from './linkedin-account.service';

@Module({
  controllers: [LinkedInAccountController],
  providers: [LinkedInAccountService],
  exports: [LinkedInAccountService],
})
export class LinkedInAccountModule {}
