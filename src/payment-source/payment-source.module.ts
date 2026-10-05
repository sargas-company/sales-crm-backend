import { Module } from '@nestjs/common';

import { PaymentSourceController } from './payment-source.controller';
import { PaymentSourceService } from './payment-source.service';

@Module({
  controllers: [PaymentSourceController],
  providers: [PaymentSourceService],
  exports: [PaymentSourceService],
})
export class PaymentSourceModule {}
