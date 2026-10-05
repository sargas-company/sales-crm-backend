import { Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

@Module({
  imports: [SettingsModule],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
