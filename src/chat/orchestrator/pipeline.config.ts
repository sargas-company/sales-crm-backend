// ─── LLM Models ──────────────────────────────────────────────────────────────

/** Claude model used for generating the main chat response */
export const LLM_MODEL = 'claude-opus-4-6';

/** Max tokens the LLM can generate per response */
export const LLM_MAX_TOKENS = 4096;

/** Model used for task classification */
export const CLASSIFIER_MODEL = 'claude-sonnet-4-6';

/** Model used for summary generation */
export const SUMMARY_MODEL = 'claude-sonnet-4-6';

// ─── Knowledge Retrieval (two-stage LLM filter) ───────────────────────────────

/** Model for stage 1: filters all document titles → candidate IDs */
export const TITLE_FILTER_MODEL = 'claude-sonnet-4-6';

/** Model for stage 2: filters candidate documents by full content → final IDs */
export const CONTENT_FILTER_MODEL = 'claude-sonnet-4-6';

/** Max characters of each document's content sent to stage 2 */
export const CONTENT_FILTER_DOC_LIMIT = 4000;

/** Separator between knowledge documents in the final prompt */
export const KNOWLEDGE_SEPARATOR = '\n\n---\n\n';

// ─── Knowledge Ingestion ─────────────────────────────────────────────────────

/** Max input text length accepted by POST /knowledge/ingest */
export const CONTENT_MAX_LENGTH = 20_000;

// ─── Prompt Assembly ─────────────────────────────────────────────────────────

/** Number of recent messages loaded from DB and passed into the prompt as history */
export const HISTORY_LIMIT = 20;

/** Max characters from job post rawText included in the [JOB POST] block */
export const JOB_POST_LIMIT = 1500;

/** Max characters of the user's message passed to the LLM */
export const USER_CONTENT_LIMIT = 2000;

// ─── Summary / Memory ────────────────────────────────────────────────────────

/** Trigger background summary regeneration after every N messages in a chat */
export const SUMMARY_TRIGGER_EVERY = 20;

/** Max characters of the generated summary stored in DB */
export const SUMMARY_MAX_LENGTH = 1500;

/** Recent messages excluded from summary compression (they go into history directly) */
export const HISTORY_KEEP_RECENT = 20;

/** Max number of older messages fed into summary generation */
export const HISTORY_MAX_OLD = 100;

/** Chats with messages within this window are included in the daily summary cron */
export const ACTIVE_CHAT_WINDOW_HOURS = 24;

/** Number of chats processed in parallel during the daily summary cron */
export const SUMMARY_BATCH_SIZE = 5;
