import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PromptModule } from '../prompt/prompt.module';
import { ChatMessageOrchestratorService } from './orchestrator/chat-message-orchestrator.service';
import { ConversationContextService } from './orchestrator/conversation-context.service';
import { KnowledgeRetrievalService } from './orchestrator/knowledge-retrieval.service';
import { LlmGatewayService } from './orchestrator/llm-gateway.service';
import { MessageService } from './orchestrator/message.service';
import { PromptAssemblyService } from './orchestrator/prompt-assembly.service';
import { RuntimeDomainContextService } from './orchestrator/runtime-domain-context.service';
import { SummaryService } from './orchestrator/summary.service';
import { TaskClassifierService } from './orchestrator/task-classifier.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [AuthModule, PromptModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatGateway,
    ChatMessageOrchestratorService,
    MessageService,
    ConversationContextService,
    RuntimeDomainContextService,
    TaskClassifierService,
    KnowledgeRetrievalService,
    PromptAssemblyService,
    LlmGatewayService,
    SummaryService,
  ],
  exports: [ChatService, ChatMessageOrchestratorService],
})
export class ChatModule {}
