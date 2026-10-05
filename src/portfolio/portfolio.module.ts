import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';

@Module({
  imports: [AuthModule, PrismaModule, SettingsModule, StorageModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
