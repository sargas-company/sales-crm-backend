import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { AiUsageLedgerService } from './ai-usage-ledger.service';

@Module({
  imports: [PrismaModule],
  providers: [AiUsageLedgerService],
  exports: [AiUsageLedgerService],
})
export class AiUsageLedgerModule {}
