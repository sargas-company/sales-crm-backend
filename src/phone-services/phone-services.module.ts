import { Module } from '@nestjs/common';

import { PhoneServicesController } from './phone-services.controller';
import { PhoneServicesService } from './phone-services.service';

@Module({
  controllers: [PhoneServicesController],
  providers: [PhoneServicesService],
  exports: [PhoneServicesService],
})
export class PhoneServicesModule {}
