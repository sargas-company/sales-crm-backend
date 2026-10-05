import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { PhoneNumbersController } from './phone-numbers.controller';
import { PhoneNumbersService } from './phone-numbers.service';
import { PhoneMaintenanceService } from './phone-maintenance.service';
import { PhoneMaintenanceScheduler } from './phone-maintenance.scheduler';

@Module({
  imports: [AuthModule, PrismaModule, SettingsModule, ConfigModule],
  controllers: [PhoneNumbersController],
  providers: [
    PhoneNumbersService,
    PhoneMaintenanceService,
    PhoneMaintenanceScheduler,
  ],
  exports: [PhoneNumbersService, PhoneMaintenanceService],
})
export class PhoneNumbersModule {}
