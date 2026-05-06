import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PromptModule } from '../prompt/prompt.module';
import { AiRecoveryService } from './orchestrator/ai-recovery.service';
import { AttachmentPreprocessorService } from './orchestrator/attachment-preprocessor.service';
import { AttachmentProcessorService } from './orchestrator/attachment-processor.service';
import { AttachmentQueueService } from './orchestrator/attachment-queue.service';
import { AttachmentRecoveryService } from './orchestrator/attachment-recovery.service';
import { BaseKnowledgeGateService } from './orchestrator/base-knowledge-gate.service';
import { BaseKnowledgeSelectorService } from './orchestrator/base-knowledge-selector.service';
import { ChatMessageOrchestratorService } from './orchestrator/chat-message-orchestrator.service';
import { ConversationContextService } from './orchestrator/conversation-context.service';
import { FileParserService } from './orchestrator/file-parser.service';
import { LlmGatewayService } from './orchestrator/llm-gateway.service';
import { MessageReadinessService } from './orchestrator/message-readiness.service';
import { MessageService } from './orchestrator/message.service';
import { PromptAssemblyService } from './orchestrator/prompt-assembly.service';
import { RuntimeDomainContextService } from './orchestrator/runtime-domain-context.service';
import { SummaryService } from './orchestrator/summary.service';
import { ProposalChatController } from './chat-send.controller';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [AuthModule, PromptModule],
  controllers: [ChatController, ProposalChatController],
  providers: [
    ChatBroadcastService,
    ChatService,
    ChatGateway,
    ChatMessageOrchestratorService,
    AttachmentPreprocessorService,
    AttachmentQueueService,
    AttachmentProcessorService,
    FileParserService,
    BaseKnowledgeGateService,
    BaseKnowledgeSelectorService,
    AiRecoveryService,
    AttachmentRecoveryService,
    MessageReadinessService,
    MessageService,
    ConversationContextService,
    RuntimeDomainContextService,
    PromptAssemblyService,
    LlmGatewayService,
    SummaryService,
  ],
  exports: [ChatService, ChatMessageOrchestratorService],
})
export class ChatModule {}
