import { ChatMessage, JobPost, Lead, Proposal } from '@prisma/client';

export interface DomainContext {
  proposal: (Proposal & { jobPost: JobPost | null }) | null;
  lead: Lead | null;
}

export type ClassifierResult = {
  intent: string;
  needsKnowledge: boolean;
};

export interface PromptInput {
  userContent: string;
  history: ChatMessage[];
  summary: string | null;
  domainContext: DomainContext;
  knowledgeSnippets: string[];
}

export type SystemBlock =
  | { type: 'text'; text: string; cache_control: { type: 'ephemeral' } }
  | { type: 'text'; text: string };

export interface BuiltPrompt {
  systemBlocks: SystemBlock[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}
