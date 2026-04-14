import { Module } from '@nestjs/common';

import { EmbeddingModule } from '../embedding/embedding.module';
import { BaseKnowledgeController } from './base-knowledge.controller';
import { BaseKnowledgeService } from './base-knowledge.service';

@Module({
  imports: [EmbeddingModule],
  controllers: [BaseKnowledgeController],
  providers: [BaseKnowledgeService],
  exports: [BaseKnowledgeService],
})
export class BaseKnowledgeModule {}
