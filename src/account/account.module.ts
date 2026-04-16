import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [PlatformModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
