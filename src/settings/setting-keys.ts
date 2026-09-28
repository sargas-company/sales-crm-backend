export const SettingKey = {
  JOB_SCANNER_ENABLED: 'job_scanner.enabled',
  JOB_SCANNER_NOTIFICATIONS_MIN_SCORE: 'job_scanner.notifications.min_score',
  INVOICE_CLIENT_DETAILS: 'invoice.client.details',
  INVOICE_CONTRACTOR_DETAILS: 'invoice.contractor.details',
} as const;

export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];
