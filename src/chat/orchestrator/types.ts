import {
  ChatMessage,
  JobPost,
  KnowledgeDocument,
  Lead,
  MessageAttachment,
  Proposal,
} from '@prisma/client';

// Used by RuntimeDomainContextService
export interface DomainContext {
  proposal: (Proposal & { jobPost: JobPost | null }) | null;
  lead: Lead | null;
}

export interface PromptInput {
  latestUserMessage: string;
  recentMessages: ChatMessage[];
  summary: string | null;
  domainContext: DomainContext;
  selectedKnowledge: KnowledgeDocument[];
  latestAttachments: MessageAttachment[];
}

export type SystemBlock =
  | { type: 'text'; text: string; cache_control: { type: 'ephemeral' } }
  | { type: 'text'; text: string };

export interface BuiltPrompt {
  systemBlocks: SystemBlock[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}
