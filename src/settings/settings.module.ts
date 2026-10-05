import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsController } from './settings.controller';
import { SettingsRegistryController } from './settings-registry.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [AuthModule, PrismaModule, ConfigModule],
  controllers: [SettingsController, SettingsRegistryController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
