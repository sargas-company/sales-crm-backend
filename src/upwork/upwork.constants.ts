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
  /* Exactly one of the following matches a source table. */
  section?: UpworkChangeLogSection;
  kind?: 'snapshot';
  refCategories?: UpworkReferenceCategory[];
}

export const UPWORK_REMINDER_RULES: UpworkReminderRule[] = [
  {
    key: 'portfolio-stale',
    section: 'portfolio',
    days: 2,
    label: 'Add a portfolio case',
  },
  {
    key: 'project-catalog-stale',
    section: 'project_catalog',
    days: 3,
    label: 'Recreate the weakest catalog',
  },
  {
    key: 'snapshot-stale',
    kind: 'snapshot',
    days: 7,
    label: 'Add a snapshot',
  },
  {
    key: 'contract-stale',
    section: 'contract',
    days: 30,
    label: 'Close a ready contract milestone with feedback',
  },
  {
    key: 'ref-fresh-30d',
    refCategories: ['suggestion', 'related_query', 'green_skill'],
    days: 30,
    label: 'Update reference data',
  },
  {
    key: 'ref-fresh-90d',
    refCategories: [
      'job_skill',
      'client_phrase',
      'requirement',
      'product_type',
      'hire_list_skill',
    ],
    days: 90,
    label: 'Update reference data',
  },
];

/* "views per invite" visual threshold on the analytics card. Keep in
 * sync with the frontend copy that explains it to the user. */
export const UPWORK_VPI_WARN_THRESHOLD = 50;
