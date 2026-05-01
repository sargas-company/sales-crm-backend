import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeQueryService } from './knowledge-query.service';

@Module({
  imports: [AuthModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeIngestionService, KnowledgeQueryService],
})
export class KnowledgeModule {}
