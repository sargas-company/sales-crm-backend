import { UpworkChangeLogSection, UpworkProfileTier } from '@prisma/client';

/* All reminder thresholds live here so tuning never requires chasing
 * the rules across controllers and services. Days are relative to
 * "now" at request time; a rule fires when the newest matching entry
 * is older than `days` (or when none exists at all). */
export interface UpworkReminderRule {
  key: string;
  label: string;
  days: number;
  /* Exactly one of the following selectors matches a source table.
   *  - section  : staleness of a single change-log section
   *  - sections : ANY of the listed sections keeps it green
   *  - kind     : non-change-log sources ('snapshot' today)
   */
  section?: UpworkChangeLogSection;
  sections?: UpworkChangeLogSection[];
  kind?: 'snapshot';
}

/* Primary: strict iteration cadence (vitrine profiles that drive
 *   leads — portfolio gets its own 2-day cadence; skills/title are
 *   bundled since they're usually refreshed together). */
const PRIMARY_RULES: UpworkReminderRule[] = [
  {
    key: 'portfolio-stale',
    section: 'portfolio',
    days: 2,
    label: 'Add a portfolio case',
  },
  {
    key: 'skills-title-stale',
    sections: ['skills', 'title'],
    days: 2,
    label: 'Swap one skill or tweak the title',
  },
  {
    key: 'project-catalog-stale',
    section: 'project_catalog',
    days: 3,
    label: 'Recreate the weakest catalog',
  },
  {
    key: 'overview-stale',
    section: 'overview',
    days: 30,
    label:
      'Re-check suggestions, related queries and highlighted skills, then refresh the overview',
  },
  {
    key: 'consultation-stale',
    section: 'consultation',
    days: 30,
    label: 'Refresh consultations: topics, text and skills',
  },
  {
    key: 'employment-history-stale',
    section: 'employment_history',
    days: 30,
    label: 'Add or refresh an employment history entry',
  },
  {
    key: 'certificate-stale',
    section: 'certificate',
    days: 60,
    label: 'Add a certificate or badge',
  },
  {
    key: 'snapshot-stale',
    kind: 'snapshot',
    days: 7,
    label: 'Add a snapshot',
  },
];

/* Secondary: light-touch cadence for worker / support profiles.
 *   Owner captures monthly stats and gives the profile a quarterly
 *   once-over. */
const SECONDARY_RULES: UpworkReminderRule[] = [
  {
    key: 'secondary-snapshot',
    kind: 'snapshot',
    days: 30,
    label: 'Add monthly stats: views, invites, direct messages',
  },
  {
    key: 'secondary-review',
    sections: [
      'title',
      'overview',
      'skills',
      'portfolio',
      'project_catalog',
      'consultation',
      'certificate',
      'employment_history',
      'other_experience',
    ],
    days: 90,
    label: 'Review the profile',
  },
];

export const UPWORK_REMINDER_RULES_BY_TIER: Record<
  UpworkProfileTier,
  UpworkReminderRule[]
> = {
  primary: PRIMARY_RULES,
  secondary: SECONDARY_RULES,
};

/* "views per invite" visual threshold on the analytics card. Keep in
 * sync with the frontend copy that explains it to the user. */
export const UPWORK_VPI_WARN_THRESHOLD = 50;

/* Normalize a title phrase for storage / dedup. Must match the
 * SQL expression used in the drop-reference-data migration:
 *   lower(trim(regexp_replace(value, '\s+', ' ', 'g'))) */
export function normalizeUpworkPhrase(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}
