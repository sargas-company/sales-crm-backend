import {
  UpworkChangeLogSection,
  UpworkReferenceCategory,
} from '@prisma/client';

/* All reminder thresholds live here so tuning never requires chasing
 * the rules across controllers and services. Days are relative to
 * "now" at request time; a rule fires when the newest matching entry
 * is older than `days` (or when none exists at all). */
export interface UpworkReminderRule {
  key: string;
  label: string;
  days: number;
  /* Exactly one of the following selectors matches a source table.
   *  - section   : staleness of a single change-log section
   *  - sections  : ANY of the listed sections keeps the reminder green
   *                (used by the "Daily update" rule that cares about
   *                portfolio, skills OR title)
   *  - kind      : non-change-log sources ('snapshot' today)
   *  - refCategories : staleness across the newest reference entry in
   *                any of the listed categories
   */
  section?: UpworkChangeLogSection;
  sections?: UpworkChangeLogSection[];
  kind?: 'snapshot';
  refCategories?: UpworkReferenceCategory[];
}

export const UPWORK_REMINDER_RULES: UpworkReminderRule[] = [
  {
    key: 'daily-update',
    sections: ['portfolio', 'skills', 'title'],
    days: 2,
    label:
      'Daily update: add a portfolio case, swap one skill or tweak the title',
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
      'Refresh the overview with new suggestions, related queries and numbers',
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
    key: 'snapshot-stale',
    kind: 'snapshot',
    days: 7,
    label: 'Add a snapshot',
  },
  {
    key: 'ref-fresh-30d',
    refCategories: ['suggestion', 'related_query', 'green_skill'],
    days: 30,
    label: 'Update reference data',
  },
  {
    key: 'ref-fresh-365d',
    refCategories: [
      'job_skill',
      'client_phrase',
      'requirement',
      'product_type',
    ],
    days: 365,
    label: 'Update reference data',
  },
];

/* "views per invite" visual threshold on the analytics card. Keep in
 * sync with the frontend copy that explains it to the user. */
export const UPWORK_VPI_WARN_THRESHOLD = 50;
