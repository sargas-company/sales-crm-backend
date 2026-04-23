import { Module } from '@nestjs/common';

import { CounterpartyController } from './counterparty.controller';
import { CounterpartyService } from './counterparty.service';

@Module({
  controllers: [CounterpartyController],
  providers: [CounterpartyService],
  exports: [CounterpartyService],
})
export class CounterpartyModule {}
