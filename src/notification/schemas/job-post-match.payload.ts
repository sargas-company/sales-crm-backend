export interface JobPostMatchPayload {
  jobPostId?: string | null;
  score: number;
  title?: string | null;
  url?: string | null;
  decision?: string | null;
  priority?: string | null;
  rawText?: string | null;
}

function isNullableString(v: unknown): v is string | null | undefined {
  return v === null || v === undefined || typeof v === 'string';
}

export function parseJobPostMatchPayload(
  raw: unknown,
): JobPostMatchPayload | null {
  if (!raw || typeof raw !== 'object') return null;

  const p = raw as Record<string, unknown>;

  if (typeof p.score !== 'number') return null;
  if (!isNullableString(p.title)) return null;
  if (!isNullableString(p.url)) return null;
  if (!isNullableString(p.decision)) return null;
  if (!isNullableString(p.priority)) return null;
  if (!isNullableString(p.rawText)) return null;

  return p as unknown as JobPostMatchPayload;
}
