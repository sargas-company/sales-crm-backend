import { Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';

@Module({
  imports: [SettingsModule],
  controllers: [TimeOffController],
  providers: [TimeOffService],
  exports: [TimeOffService],
})
export class TimeOffModule {}
