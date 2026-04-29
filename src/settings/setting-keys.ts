export const SettingKey = {
  JOB_SCANNER_ENABLED: 'job_scanner.enabled',
  JOB_SCANNER_BACKFILL_ENABLED: 'job_scanner.backfill.enabled',
  JOB_SCANNER_BACKFILL_LIMIT: 'job_scanner.backfill.limit',
  JOB_SCANNER_NOTIFICATIONS_MIN_SCORE: 'job_scanner.notifications.min_score',
  JOB_SCANNER_TELEGRAM_SESSION: 'job_scanner.telegram.session',
  JOB_SCANNER_TELEGRAM_CONNECTED: 'job_scanner.telegram.connected',
  INVOICE_CLIENT_DETAILS: 'invoice.client.details',
  INVOICE_CONTRACTOR_DETAILS: 'invoice.contractor.details',
} as const;

export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];
