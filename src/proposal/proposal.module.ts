import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module';
import { LeadModule } from '../lead/lead.module';
import { ProposalController } from './proposal.controller';
import { ProposalService } from './proposal.service';

@Module({
  imports: [ChatModule, LeadModule],
  controllers: [ProposalController],
  providers: [ProposalService],
  exports: [ProposalService],
})
export class ProposalModule {}
