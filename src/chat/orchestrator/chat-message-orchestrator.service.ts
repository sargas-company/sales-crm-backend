import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeDocument } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AttachmentPreprocessorService } from './attachment-preprocessor.service';
import { BaseKnowledgeGateService } from './base-knowledge-gate.service';
import { BaseKnowledgeSelectorService } from './base-knowledge-selector.service';
import { ConversationContextService } from './conversation-context.service';
import { LlmGatewayService } from './llm-gateway.service';
import { MessageService } from './message.service';
import { PromptAssemblyService } from './prompt-assembly.service';
import { RuntimeDomainContextService } from './runtime-domain-context.service';
import { SummaryService } from './summary.service';
import { HISTORY_LIMIT, SUMMARY_TRIGGER_EVERY } from './pipeline.config';
import { BuiltPrompt } from './types';

interface PipelineResult {
  chatId: string;
  systemBlocks: BuiltPrompt['systemBlocks'];
  messages: BuiltPrompt['messages'];
}

export interface StreamHandle {
  chatId: string;
  stream: AsyncGenerator<string>;
}

@Injectable()
export class ChatMessageOrchestratorService {
  private readonly logger = new Logger(ChatMessageOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messageService: MessageService,
    private readonly conversationContext: ConversationContextService,
    private readonly runtimeContext: RuntimeDomainContextService,
    private readonly attachmentPreprocessor: AttachmentPreprocessorService,
    private readonly summaryService: SummaryService,
    private readonly knowledgeGate: BaseKnowledgeGateService,
    private readonly knowledgeSelector: BaseKnowledgeSelectorService,
    private readonly promptAssembly: PromptAssemblyService,
    private readonly llmGateway: LlmGatewayService,
  ) {}

  /**
   * Builds the prompt pipeline and returns a raw chunk stream.
   * Pure: no side effects, no assistant saves, no fallbacks.
   * Throws if pipeline build or LLM stream fails — caller owns error handling.
   */
  async buildStream(
    proposalId: string,
    content: string,
    userId: string,
    preCreatedMessageId?: string,
  ): Promise<StreamHandle> {
    const { chatId, systemBlocks, messages } = await this.buildPipeline(
      proposalId,
      content,
      userId,
      preCreatedMessageId,
    );

    const stream = this.streamChunks(systemBlocks, messages);
    return { chatId, stream };
  }

  private async *streamChunks(
    systemBlocks: BuiltPrompt['systemBlocks'],
    messages: BuiltPrompt['messages'],
  ): AsyncGenerator<string> {
    for await (const chunk of this.llmGateway.stream(systemBlocks, messages)) {
      yield chunk;
    }
  }

  private async buildPipeline(
    proposalId: string,
    content: string,
    userId: string,
    preCreatedMessageId?: string,
  ): Promise<PipelineResult> {
    // ── 1. Resolve chat + save user message ──────────────────────────────────
    const chat = await this.runtimeContext.resolveChat(proposalId, userId);
    const userMessage = preCreatedMessageId
      ? { id: preCreatedMessageId }
      : await this.messageService.saveUser(chat.id, content);

    // Background cron-summary trigger (unchanged)
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

    // ── 2. Parallel: recent history + attachments + cached summary + domain ctx
    const [allMessages, latestAttachments, cachedSummary, domainContext] =
      await Promise.all([
        this.conversationContext.getHistory(chat.id, HISTORY_LIMIT),
        this.messageService.getAttachmentsForMessage(userMessage.id),
        this.summaryService.getLatestSummary(chat.id),
        this.runtimeContext.load(chat.proposalId, chat.leadId),
      ]);

    const attachmentsDone = latestAttachments.filter(
      (a) => (a as unknown as { status?: string }).status === 'DONE',
    );
    const attachmentsWithText = attachmentsDone.filter(
      (a) => a.textRepresentation,
    );
    this.logger.log(
      `context loaded | history=${allMessages.length} msgs` +
        ` | attachments=${latestAttachments.length}` +
        ` (done=${attachmentsDone.length}, with_text=${attachmentsWithText.length})` +
        ` | summary=${cachedSummary ? `${cachedSummary.length} chars` : 'none'}` +
        ` | vacancy=${!!domainContext.proposal?.vacancy}` +
        ` | lead=${!!domainContext.lead}`,
    );

    // ── 3. Embed parsed attachment text into messages (read-only, no parsing) ─
    const recentMessages =
      await this.attachmentPreprocessor.processMessages(allMessages);

    // ── 4. Summary from DB covers everything older than HISTORY_LIMIT ─────────
    const summary = cachedSummary ?? null;

    // ── 5. Base Knowledge Gate ───────────────────────────────────────────────
    const { needsBaseKnowledge } = await this.knowledgeGate
      .decide({
        latestUserMessage: content,
        summary,
        recentMessages,
        latestAttachments,
      })
      .catch((err) => {
        this.logger.error(
          'knowledge gate failed, defaulting to false',
          err instanceof Error ? err.stack : String(err),
        );
        return { needsBaseKnowledge: false };
      });

    this.logger.log(`gate decision | needsBaseKnowledge=${needsBaseKnowledge}`);

    // ── 6. Base Knowledge Selector ───────────────────────────────────────────
    let selectedKnowledge: KnowledgeDocument[] = [];

    if (needsBaseKnowledge) {
      const knowledgeItems = await this.prisma.knowledgeDocument.findMany({
        where: { isActive: true },
      });

      const { selectedKnowledgeIds } = await this.knowledgeSelector
        .select({
          latestUserMessage: content,
          summary,
          recentMessages,
          latestAttachments,
          knowledgeItems,
        })
        .catch((err) => {
          this.logger.error(
            'knowledge selector failed, using empty selection',
            err instanceof Error ? err.stack : String(err),
          );
          return { selectedKnowledgeIds: [] as string[] };
        });

      selectedKnowledge = knowledgeItems.filter((k) =>
        selectedKnowledgeIds.includes(k.id),
      );

      this.logger.log(
        `selector | selected=${selectedKnowledge.length}/${knowledgeItems.length} knowledge items`,
      );
    }

    // ── 7. Prompt assembly ───────────────────────────────────────────────────
    const { systemBlocks, messages } = await this.promptAssembly.buildPrompt({
      latestUserMessage: content,
      recentMessages,
      summary,
      domainContext,
      selectedKnowledge,
      latestAttachments,
    });

    const systemChars = systemBlocks.reduce((s, b) => s + b.text.length, 0);
    const messagesChars = messages.reduce(
      (s, m) => s + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );
    this.logger.log(
      `prompt built | system_blocks=${systemBlocks.length} (${systemChars} chars)` +
        ` | messages=${messages.length} (${messagesChars} chars total)`,
    );

    return { chatId: chat.id, systemBlocks, messages };
  }
}
