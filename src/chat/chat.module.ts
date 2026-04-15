import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BaseKnowledgeModule } from '../base-knowledge/base-knowledge.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [BaseKnowledgeModule, AuthModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}
