/**
 * Vibe Worker payload mapping.
 *
 * `mapVibeJobPayload` is a pure function that turns the real
 * `job.matched` event emitted by Vibe Worker into the data that a
 * `JobPost` row needs. It is designed to be the single typed
 * contract between the ingest layer and the rest of the Scanner Core
 * pipeline.
 *
 * The real payload shape, verbatim from production:
 *
 *   {
 *     "event":    "job.matched",
 *     "filterName": "All Jobs",
 *     "matchedAt": "<ISO>",
 *     "job":      { id, url, type, title, description, budget{min,max,display,currency},
 *                   skills[], duration, postedAt, questions[], categories[],
 *                   contractType, hoursPerWeek, experienceLevel, connectsRequired },
 *     "match":    { reasoning, scoreQuickWin, scoreRedFlags, scoreScopeClarity,
 *                   effortEstimateHours },
 *     "client":   { hires, rating, hireRate, location, rankLabel, rankScore,
 *                   jobsPosted, totalSpent, reviewCount, avgHourlyRate,
 *                   paymentVerified, locationRestriction }
 *   }
 *
 * `null` return value means the payload is NOT a Vibe `job.matched`
 * event with a usable job id — i.e. demo / diagnostic traffic. The
 * processor treats that as `SKIPPED` on the ingest-event row and
 * does NOT create a JobPost.
 */

export const VIBE_SCANNER_LABEL = 'vibe-worker';

export interface VibeJobMapped {
  providerJobId: string;
  title: string;
  jobUrl: string;
  rawText: string;
  rawPayload: unknown;
  scanner: string;
  location: string | null;
  budget: string | null;
  totalSpent: number | null;
  avgRatePaid: number | null;
  hireRate: number | null;
  hSkillsKeywords: string[];
}

interface MaybeVibePayload {
  event?: unknown;
  job?: unknown;
  client?: unknown;
  match?: unknown;
}

export function isVibeJobMatchedPayload(raw: unknown): raw is {
  event: 'job.matched';
  job: { id: string } & Record<string, unknown>;
  client?: Record<string, unknown>;
  match?: Record<string, unknown>;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const payload = raw as MaybeVibePayload;
  if (payload.event !== 'job.matched') return false;
  if (!payload.job || typeof payload.job !== 'object' || Array.isArray(payload.job)) return false;
  const job = payload.job as { id?: unknown };
  if (typeof job.id !== 'string' || job.id.trim().length === 0) return false;
  return true;
}

export function mapVibeJobPayload(raw: unknown): VibeJobMapped | null {
  if (!isVibeJobMatchedPayload(raw)) return null;
  const job = raw.job as Record<string, unknown> & { id: string };
  const client = (raw.client ?? {}) as Record<string, unknown>;

  return {
    providerJobId: job.id,
    title: str(job.title) ?? '',
    jobUrl: str(job.url) ?? '',
    rawText: buildAiText(raw),
    rawPayload: raw,
    scanner: VIBE_SCANNER_LABEL,
    location: str(client.location),
    budget: formatBudget(job.budget, str(job.type)),
    totalSpent: num(client.totalSpent),
    avgRatePaid: num(client.avgHourlyRate),
    hireRate: num(client.hireRate),
    hSkillsKeywords: toStringArray(job.skills),
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function formatBudget(raw: unknown, type: string | null): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as { min?: unknown; max?: unknown; display?: unknown; currency?: unknown };
  const display = str(b.display);
  if (display) return display;
  const currency = str(b.currency) ?? 'USD';
  const min = num(b.min);
  const max = num(b.max);
  const suffix = type === 'hourly' ? '/hr' : '';
  if (min !== null && max !== null && min !== max) return `${currency} ${min}–${max}${suffix}`;
  if (min !== null) return `${currency} ${min}${suffix}`;
  if (max !== null) return `${currency} ${max}${suffix}`;
  return null;
}

/**
 * Deterministic denormalised text the AI evaluator reads. Keeping this
 * stable means a re-run on the same payload produces the same prompt
 * body and (modulo model stochasticity) the same evaluation.
 */
function buildAiText(payload: unknown): string {
  const root = payload as {
    job?: Record<string, unknown>;
    client?: Record<string, unknown>;
    match?: Record<string, unknown>;
    matchedAt?: unknown;
  };
  const job = (root.job ?? {}) as Record<string, unknown>;
  const client = (root.client ?? {}) as Record<string, unknown>;

  const lines: string[] = [];
  const title = str(job.title);
  if (title) lines.push(`Title: ${title}`);
  const url = str(job.url);
  if (url) lines.push(`URL: ${url}`);
  const type = str(job.type);
  if (type) lines.push(`Type: ${type}`);
  const budget = formatBudget(job.budget, type);
  if (budget) lines.push(`Budget: ${budget}`);
  const duration = str(job.duration);
  if (duration) lines.push(`Duration: ${duration}`);
  const hoursPerWeek = str(job.hoursPerWeek);
  if (hoursPerWeek) lines.push(`Hours/week: ${hoursPerWeek}`);
  const experience = str(job.experienceLevel);
  if (experience) lines.push(`Experience: ${experience}`);
  const contract = str(job.contractType);
  if (contract) lines.push(`Contract: ${contract}`);
  const connects = num(job.connectsRequired);
  if (connects !== null) lines.push(`Connects required: ${connects}`);
  const postedAt = str(job.postedAt);
  if (postedAt) lines.push(`Posted at: ${postedAt}`);
  const skills = toStringArray(job.skills);
  if (skills.length) lines.push(`Skills: ${skills.join(', ')}`);
  const categories = toStringArray(job.categories);
  if (categories.length) lines.push(`Categories: ${categories.join(', ')}`);

  const description = str(job.description);
  if (description) lines.push('', 'Description:', description);

  const clientLines: string[] = [];
  const location = str(client.location);
  if (location) clientLines.push(`Location: ${location}`);
  const paymentVerified = client.paymentVerified;
  if (typeof paymentVerified === 'boolean') {
    clientLines.push(`Payment verified: ${paymentVerified}`);
  }
  const totalSpent = num(client.totalSpent);
  if (totalSpent !== null) clientLines.push(`Total spent: ${totalSpent}`);
  const avgHourly = num(client.avgHourlyRate);
  if (avgHourly !== null) clientLines.push(`Avg hourly rate: ${avgHourly}`);
  const hires = num(client.hires);
  if (hires !== null) clientLines.push(`Hires: ${hires}`);
  const hireRate = num(client.hireRate);
  if (hireRate !== null) clientLines.push(`Hire rate: ${hireRate}`);
  const rating = num(client.rating);
  if (rating !== null) clientLines.push(`Rating: ${rating}`);
  const reviewCount = num(client.reviewCount);
  if (reviewCount !== null) clientLines.push(`Reviews: ${reviewCount}`);
  const jobsPosted = num(client.jobsPosted);
  if (jobsPosted !== null) clientLines.push(`Jobs posted: ${jobsPosted}`);
  const rankLabel = str(client.rankLabel);
  if (rankLabel) clientLines.push(`Rank: ${rankLabel}`);
  if (clientLines.length) lines.push('', 'Client:', ...clientLines);

  const match = (root.match ?? {}) as Record<string, unknown>;
  const reasoning = str(match.reasoning);
  if (reasoning) lines.push('', 'Vibe reasoning:', reasoning);

  return lines.join('\n');
}
