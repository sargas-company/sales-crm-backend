interface ParsedJobPostFields {
  title: string | null;
  jobUrl: string | null;
  scanner: string | null;
  gigRadarScore: number | null;
  location: string | null;
  budget: string | null;
  totalSpent: number | null;
  avgRatePaid: number | null;
  hireRate: number | null;
  hSkillsKeywords: string[];
}

export function parseJobPostFields(
  rawText: string,
  rawPayload: object,
): ParsedJobPostFields {
  const title =
    rawText.match(/📡 New opportunity detected\n(.+)/)?.[1]?.trim() ?? null;

  const entities = (rawPayload as Record<string, unknown>)?.entities;
  const jobUrl =
    (Array.isArray(entities)
      ? entities.find(
          (e: Record<string, unknown>) =>
            e.className === 'MessageEntityTextUrl' &&
            typeof e.url === 'string' &&
            e.url.includes('upwork.com/jobs/'),
        )?.url
      : null) ?? null;

  const scanner = rawText.match(/Scanner:\s*(.+)/)?.[1]?.trim() ?? null;

  const gigRadarRaw = rawText.match(/GigRadar Score:\s*(\d+)%/)?.[1];
  const gigRadarScore = gigRadarRaw != null ? parseInt(gigRadarRaw, 10) : null;

  const location = rawText.match(/Location:\s*(.+)/)?.[1]?.trim() ?? null;

  const budgetRaw = rawText.match(/Budget:\s*(.+)/)?.[1]?.trim() ?? null;
  const budget = !budgetRaw || budgetRaw === '-' ? null : budgetRaw;

  const totalSpentRaw = rawText.match(/Total Spent:\s*\$?([\d,]+\.?\d*)/)?.[1];
  const totalSpent =
    totalSpentRaw != null ? parseFloat(totalSpentRaw.replace(/,/g, '')) : null;

  const avgRateRaw = rawText.match(/Avg Rate Paid:\s*\$?([\d,]+\.?\d*)/)?.[1];
  const avgRatePaid =
    avgRateRaw != null ? parseFloat(avgRateRaw.replace(/,/g, '')) : null;

  const hireRateRaw = rawText.match(/Hire Rate:\s*([\d.]+)/)?.[1];
  const hireRate = hireRateRaw != null ? parseFloat(hireRateRaw) : null;

  const hSkillsRaw =
    rawText.match(/HSkills Keywords:\s*(.+)/)?.[1]?.trim() ?? '';
  const hSkillsKeywords =
    !hSkillsRaw || hSkillsRaw === '-'
      ? []
      : hSkillsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  return {
    title,
    jobUrl,
    scanner,
    gigRadarScore,
    location,
    budget,
    totalSpent,
    avgRatePaid,
    hireRate,
    hSkillsKeywords,
  };
}
