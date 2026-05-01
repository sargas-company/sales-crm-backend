import { Injectable, Logger } from '@nestjs/common';

import { ConversationContextService } from './conversation-context.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { LlmGatewayService } from './llm-gateway.service';
import { MessageService } from './message.service';
import { PromptAssemblyService } from './prompt-assembly.service';
import { RuntimeDomainContextService } from './runtime-domain-context.service';
import { SummaryService } from './summary.service';
import { TaskClassifierService } from './task-classifier.service';
import { SUMMARY_TRIGGER_EVERY } from './pipeline.config';
import { BuiltPrompt, ClassifierResult } from './types';

const FALLBACK_RESPONSE = 'Something went wrong. Please try again.';

const CLASSIFIER_FALLBACK: ClassifierResult = {
  intent: 'general',
  needsKnowledge: false,
};

interface PipelineResult {
  chatId: string;
  classifierResult: ClassifierResult;
  systemBlocks: BuiltPrompt['systemBlocks'];
  messages: BuiltPrompt['messages'];
}

@Injectable()
export class ChatMessageOrchestratorService {
  private readonly logger = new Logger(ChatMessageOrchestratorService.name);

  constructor(
    private readonly messageService: MessageService,
    private readonly conversationContext: ConversationContextService,
    private readonly runtimeContext: RuntimeDomainContextService,
    private readonly classifier: TaskClassifierService,
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
    private readonly promptAssembly: PromptAssemblyService,
    private readonly llmGateway: LlmGatewayService,
    private readonly summaryService: SummaryService,
  ) {}

  async *streamMessage(
    proposalId: string,
    content: string,
    userId: string,
  ): AsyncGenerator<{ type: 'chunk'; text: string }> {
    const { chatId, classifierResult, systemBlocks, messages } =
      await this.buildPipeline(proposalId, content, userId);

    try {
      let fullText = '';
      for await (const chunk of this.llmGateway.stream(
        systemBlocks,
        messages,
      )) {
        fullText += chunk;
        yield { type: 'chunk', text: chunk };
      }
      await this.messageService.saveAssistant(
        chatId,
        fullText,
        classifierResult.intent,
      );
    } catch (error) {
      this.logger.error(
        'streamMessage failed',
        error instanceof Error ? error.stack : String(error),
      );
      await this.messageService.saveAssistant(
        chatId,
        FALLBACK_RESPONSE,
        classifierResult.intent,
      );
      yield { type: 'chunk', text: FALLBACK_RESPONSE };
    }
  }

  private async buildPipeline(
    proposalId: string,
    content: string,
    userId: string,
  ): Promise<PipelineResult> {
    const chat = await this.runtimeContext.resolveChat(proposalId, userId);
    await this.messageService.saveUser(chat.id, content);

    const messageCount = await this.messageService.count(chat.id);
    if (messageCount % SUMMARY_TRIGGER_EVERY === 0) {
      this.logger.log(
        `summary trigger at message #${messageCount} for chat=${chat.id}`,
      );
      setTimeout(() => {
        this.summaryService
          .generateSummary(chat.id)
          .then((summary) => {
            if (summary)
              return this.summaryService.upsertSummary(chat.id, summary);
          })
          .catch((err) => {
            this.logger.error(
              `summary trigger failed for chat ${chat.id}`,
              err instanceof Error ? err.stack : String(err),
            );
          });
      }, 0);
    }

    const [history, summary, domainContext] = await Promise.all([
      this.conversationContext.getHistory(chat.id),
      this.summaryService.getLatestSummary(chat.id),
      this.runtimeContext.load(chat.proposalId, chat.leadId),
    ]);

    const rawClassifier = await this.classifier
      .classify(content, domainContext)
      .catch((err) => {
        this.logger.error(
          'classifier failed',
          err instanceof Error ? err.stack : String(err),
        );
        return null;
      });

    const classifierResult =
      rawClassifier && typeof rawClassifier.needsKnowledge === 'boolean'
        ? rawClassifier
        : CLASSIFIER_FALLBACK;

    const vacancyContext =
      domainContext.proposal?.vacancy ||
      domainContext.proposal?.jobPost?.rawText ||
      content;

    const knowledgeSnippets = classifierResult.needsKnowledge
      ? await this.knowledgeRetrieval.getSnippets(vacancyContext)
      : [];

    this.logger.log(
      `pipeline done | chat=${chat.id} | intent=${classifierResult.intent} | needsKnowledge=${classifierResult.needsKnowledge} | history=${history.length} | summary=${!!summary} | snippets=${knowledgeSnippets.length}`,
    );

    const { systemBlocks, messages } = await this.promptAssembly.buildPrompt({
      userContent: content,
      history,
      summary,
      domainContext,
      knowledgeSnippets,
    });

    return {
      chatId: chat.id,
      classifierResult,
      systemBlocks,
      messages,
    };
  }
}
