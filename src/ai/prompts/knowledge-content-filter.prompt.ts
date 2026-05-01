export const KNOWLEDGE_CONTENT_FILTER_PROMPT = `You are a knowledge relevance judge.

Given a job vacancy and knowledge documents (with full content), select ONLY documents that would genuinely help write a better response or proposal for this specific vacancy.

Be selective — only include documents that directly add value.

Return ONLY a JSON array of string IDs.
Examples: ["id1", "id2"] or []

No text outside JSON. No explanations.`;
