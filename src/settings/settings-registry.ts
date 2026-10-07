/**
 * Typed Settings Registry — SINGLE source of truth for every editable
 * setting the user can change through the UI.
 *
 * The database stores only the override value. All metadata
 * (type, label, section, defaults, validation, permissions, danger
 * flags, apply-immediately vs restart) lives here so that:
 *
 *   • frontend cannot inject a new key — the controller rejects
 *     anything not listed below;
 *   • invalid DB values do not crash the app — `coerce()` falls back
 *     to the registry default when the stored value is wrong shape;
 *   • a seed can idempotently create missing rows and never
 *     overwrite a user-modified value.
 *
 * Environment / security configuration (DATABASE_URL, JWT_SECRET,
 * encryption master key, webhook secrets, Redis URL) is deliberately
 * NOT in this file. Env goes through `ConfigService`, never the UI.
 */

export type RegistryType =
  | 'boolean'
  | 'number'
  | 'string'
  | 'select'
  | 'duration_minutes'
  | 'duration_seconds'
  | 'percentage'
  | 'weekdays'
  | 'currency';

export type RegistrySection =
  | 'general'
  | 'scanner_alerts'
  | 'client_invoicing'
  | 'people_time_off'
  | 'payroll_compensation'
  | 'credentials_security'
  | 'phone_alerts'
  | 'phone_defaults'
  | 'portfolio'
  | 'integrations';

export interface RegistryEntry {
  key: string;
  section: RegistrySection;
  label: string;
  description: string;
  type: RegistryType;
  default: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Permission required to see the setting. */
  viewPermission: string;
  /** Permission required to change it. */
  editPermission: string;
  /** The setting is read-only in UI (operational flag). */
  readOnly?: boolean;
  /** The setting is a sensitive flag that must be confirmed via UI
   *  prompt. Pure cosmetic hint for the frontend. */
  dangerous?: boolean;
  /** The setting is a `secret`-category value. Must never ship to
   *  frontend AND must never be writable through /settings/*. */
  sensitive?: boolean;
  /** Short help text shown next to the control explaining the live
   *  effect once a value is picked (used by the UI, not applied by
   *  backend). */
  effectHint?: string;
}

/* ─── Keys (stable string literals) ────────────────────────────── */

export const SK = {
  // General
  GENERAL_COMPANY_NAME: 'general.companyName',
  GENERAL_TIMEZONE: 'general.timezone',
  GENERAL_DATE_FORMAT: 'general.dateFormat',
  GENERAL_WEEK_STARTS_ON: 'general.weekStartsOn',
  GENERAL_DEFAULT_CURRENCY: 'general.defaultCurrency',

  // Scanner & Alerts
  SCANNER_INGESTION_ENABLED: 'scanner.ingestionEnabled',
  SCANNER_ANALYSIS_ENABLED: 'scanner.analysisEnabled',
  SCANNER_DISCORD_ALERTS_ENABLED: 'scanner.discordAlertsEnabled',
  SCANNER_DISCORD_SCORE_THRESHOLD: 'scanner.discordScoreThreshold',

  // Client Invoicing
  INVOICE_LEGAL_COMPANY_NAME: 'invoice.legalCompanyName',
  INVOICE_REGISTRATION_NUMBER: 'invoice.registrationNumber',
  INVOICE_VAT_NUMBER: 'invoice.vatNumber',
  INVOICE_LEGAL_ADDRESS: 'invoice.legalAddress',
  INVOICE_DEFAULT_CURRENCY: 'invoice.defaultCurrency',
  INVOICE_DEFAULT_PAYMENT_TERMS_DAYS: 'invoice.defaultPaymentTermsDays',
  INVOICE_NUMBER_PREFIX: 'invoice.numberPrefix',
  INVOICE_DEFAULT_NOTE: 'invoice.defaultNote',
  INVOICE_PAYMENT_INSTRUCTIONS: 'invoice.paymentInstructions',

  // People & Time Off
  TIMEOFF_VACATION_DAYS_PER_YEAR: 'timeOff.vacationDaysPerYear',
  TIMEOFF_SICK_DAYS_PER_YEAR: 'timeOff.sickDaysPerYear',
  TIMEOFF_WORKING_WEEKDAYS: 'timeOff.workingWeekdays',
  TIMEOFF_ALLOW_NEGATIVE_BALANCE: 'timeOff.allowNegativeBalance',

  // Payroll & Compensation
  PAYROLL_FIXED_TAX: 'payroll.fixedTaxComponent',
  PAYROLL_TAX_PERCENT: 'payroll.taxPercentage',
  PAYROLL_PAYONEER_FEE_PERCENT: 'payroll.payoneerFeePercentage',
  PAYROLL_LOCK_PAID_RUNS: 'payroll.lockPaidRuns',
  PAYROLL_ALLOW_OWNER_REOPEN: 'payroll.allowOwnerReopen',

  // Credentials & Security
  CREDENTIALS_VAULT_SESSION_MIN: 'credentials.vaultSessionMinutes',
  CREDENTIALS_REVEAL_AUTOHIDE_SEC: 'credentials.revealAutoHideSeconds',
  CREDENTIALS_MAX_ATTACHMENT_MB: 'credentials.maxAttachmentMegabytes',

  // Phone Alerts.
  // NOTE: `phoneAlerts.webhookUrl` and `phoneAlerts.mention` were
  // retired when phone-maintenance delivery moved to the active
  // DiscordProfile + bot (opsChannelId + managerRoleId). Any rows
  // left in the DB are harmless — nothing reads them. They are no
  // longer in the registry or the seed catalogue.
  PHONE_ALERTS_ENABLED: 'phoneMaintenance.discordRemindersEnabled',
  PHONE_ALERTS_SEND_HOUR: 'phoneMaintenance.reminderHour',
  PHONE_ALERTS_SEND_MINUTE: 'phoneAlerts.reminderMinute',
  PHONE_ALERTS_INCLUDE_DUE: 'phoneAlerts.includeDue',
  PHONE_ALERTS_INCLUDE_OVERDUE: 'phoneAlerts.includeOverdue',

  // Phone Defaults
  PHONE_DEFAULTS_TOPUP_AMOUNT: 'phoneDefaults.topUpAmount',

  // Portfolio
  PORTFOLIO_STORAGE_BUCKET: 'portfolio.storageBucket',
  PORTFOLIO_SEPARATE_FOLDERS: 'portfolio.separateFoldersByKind',
  PORTFOLIO_MAX_COVER_MB: 'portfolio.maxCoverMb',
  PORTFOLIO_MAX_GALLERY_ITEMS: 'portfolio.maxGalleryItems',
  PORTFOLIO_MAX_GALLERY_MB: 'portfolio.maxGalleryImageMb',
  PORTFOLIO_MAX_FILES: 'portfolio.maxFiles',
  PORTFOLIO_MAX_FILE_MB: 'portfolio.maxFileMb',
  PORTFOLIO_MAX_FILES_TOTAL_MB: 'portfolio.maxFilesTotalMb',
  PORTFOLIO_DEFAULT_STATUS: 'portfolio.defaultStatus',
  PORTFOLIO_AUTO_SLUG: 'portfolio.autoSlug',
  PORTFOLIO_PDF_EXPORT_ENABLED: 'portfolio.pdfExportEnabled',
} as const;

export type RegistryKey = (typeof SK)[keyof typeof SK];

/* ─── Permission presets ───────────────────────────────────────── */

const OWNER_ONLY = 'settings:update';
const SCANNER_EDIT = 'settings_scanner:update';
const INVOICING_EDIT = 'settings_invoicing:update';
const SETTINGS_VIEW = 'settings:view';

/* ─── Registry ─────────────────────────────────────────────────── */

export const SETTINGS_REGISTRY: Record<string, RegistryEntry> = {
  // ── General ────────────────────────────────────────────────────
  [SK.GENERAL_COMPANY_NAME]: {
    key: SK.GENERAL_COMPANY_NAME,
    section: 'general',
    label: 'Workspace name',
    description: 'The brand/company name shown across the app.',
    type: 'string',
    default: 'Sargas',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.GENERAL_TIMEZONE]: {
    key: SK.GENERAL_TIMEZONE,
    section: 'general',
    label: 'Timezone',
    description:
      'IANA timezone that drives user-facing schedules (phone-maintenance Discord reminders, calendar-day deduplication). Stored timestamps stay in UTC — only business time comparisons move to this zone.',
    type: 'select',
    default: 'Europe/Kyiv',
    effectHint:
      'A change takes effect on the next scheduler tick. Invalid or unknown zones fall back to Europe/Kyiv.',
    options: [
      { value: 'Europe/Kyiv', label: 'Europe/Kyiv (default)' },
      { value: 'Europe/Warsaw', label: 'Europe/Warsaw' },
      { value: 'Europe/London', label: 'Europe/London' },
      { value: 'America/New_York', label: 'America/New_York' },
      { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
      { value: 'UTC', label: 'UTC' },
    ],
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.GENERAL_DATE_FORMAT]: {
    key: SK.GENERAL_DATE_FORMAT,
    section: 'general',
    label: 'Date format',
    description: 'How dates render in lists and reports.',
    type: 'select',
    default: 'DD.MM.YYYY',
    options: [
      { value: 'DD.MM.YYYY', label: 'DD.MM.YYYY · 24.10.2026' },
      { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY · 10/24/2026' },
      { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD · 2026-10-24' },
    ],
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.GENERAL_WEEK_STARTS_ON]: {
    key: SK.GENERAL_WEEK_STARTS_ON,
    section: 'general',
    label: 'Week starts on',
    description: 'First column in week grids and date pickers.',
    type: 'select',
    default: 'monday',
    options: [
      { value: 'monday', label: 'Monday' },
      { value: 'sunday', label: 'Sunday' },
    ],
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.GENERAL_DEFAULT_CURRENCY]: {
    key: SK.GENERAL_DEFAULT_CURRENCY,
    section: 'general',
    label: 'Default currency',
    description: 'Used wherever a currency is not explicitly specified.',
    type: 'currency',
    default: 'USD',
    options: [
      { value: 'USD', label: 'USD · US dollar' },
      { value: 'EUR', label: 'EUR · Euro' },
      { value: 'UAH', label: 'UAH · Ukrainian hryvnia' },
      { value: 'GBP', label: 'GBP · Pound sterling' },
    ],
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },

  // ── Scanner & Alerts ───────────────────────────────────────────
  [SK.SCANNER_INGESTION_ENABLED]: {
    key: SK.SCANNER_INGESTION_ENABLED,
    section: 'scanner_alerts',
    label: 'Vibe Worker ingestion',
    description:
      'Accept new job-post events from the Vibe Worker webhook. When off, incoming events are rejected before storage.',
    type: 'boolean',
    default: true,
    dangerous: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
    effectHint:
      'Turning this off stops new job posts from being saved. Live webhook requests return 503.',
  },
  [SK.SCANNER_ANALYSIS_ENABLED]: {
    key: SK.SCANNER_ANALYSIS_ENABLED,
    section: 'scanner_alerts',
    label: 'Automated analysis',
    description:
      'Run Gatekeeper + Evaluation prompts against incoming job posts.',
    type: 'boolean',
    default: true,
    dangerous: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
    effectHint:
      'Off: posts are saved raw but never scored. On: full AI pipeline runs.',
  },
  [SK.SCANNER_DISCORD_ALERTS_ENABLED]: {
    key: SK.SCANNER_DISCORD_ALERTS_ENABLED,
    section: 'scanner_alerts',
    label: 'Discord alerts',
    description: 'Send scored posts to the configured Discord channel.',
    type: 'boolean',
    default: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: SCANNER_EDIT,
  },
  [SK.SCANNER_DISCORD_SCORE_THRESHOLD]: {
    key: SK.SCANNER_DISCORD_SCORE_THRESHOLD,
    section: 'scanner_alerts',
    label: 'Alert score threshold',
    description:
      'Minimum post score that triggers a Discord notification.',
    type: 'number',
    default: 50,
    min: 0,
    max: 100,
    viewPermission: SETTINGS_VIEW,
    editPermission: SCANNER_EDIT,
    effectHint:
      'Job Posts with score at or above this value are sent to Discord.',
  },

  // ── Client Invoicing ───────────────────────────────────────────
  [SK.INVOICE_LEGAL_COMPANY_NAME]: {
    key: SK.INVOICE_LEGAL_COMPANY_NAME,
    section: 'client_invoicing',
    label: 'Legal company name',
    description:
      'Shown as the issuer on client-facing invoices. Changing this does not rewrite existing invoices.',
    type: 'string',
    default: '',
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },
  [SK.INVOICE_REGISTRATION_NUMBER]: {
    key: SK.INVOICE_REGISTRATION_NUMBER,
    section: 'client_invoicing',
    label: 'Registration number',
    description: 'Legal registration / tax ID of the company.',
    type: 'string',
    default: '',
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },
  [SK.INVOICE_VAT_NUMBER]: {
    key: SK.INVOICE_VAT_NUMBER,
    section: 'client_invoicing',
    label: 'VAT number',
    description: 'Optional VAT registration ID.',
    type: 'string',
    default: '',
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },
  [SK.INVOICE_LEGAL_ADDRESS]: {
    key: SK.INVOICE_LEGAL_ADDRESS,
    section: 'client_invoicing',
    label: 'Legal address',
    description: 'Full address printed on invoices.',
    type: 'string',
    default: '',
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },
  [SK.INVOICE_DEFAULT_CURRENCY]: {
    key: SK.INVOICE_DEFAULT_CURRENCY,
    section: 'client_invoicing',
    label: 'Default invoice currency',
    description: 'Pre-selected currency when drafting a new invoice.',
    type: 'currency',
    default: 'USD',
    options: [
      { value: 'USD', label: 'USD · US dollar' },
      { value: 'EUR', label: 'EUR · Euro' },
      { value: 'UAH', label: 'UAH · Ukrainian hryvnia' },
      { value: 'GBP', label: 'GBP · Pound sterling' },
    ],
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },
  [SK.INVOICE_DEFAULT_PAYMENT_TERMS_DAYS]: {
    key: SK.INVOICE_DEFAULT_PAYMENT_TERMS_DAYS,
    section: 'client_invoicing',
    label: 'Default payment terms',
    description: 'Default number of days from issue date to due date.',
    type: 'number',
    default: 14,
    min: 0,
    max: 365,
    unit: 'days',
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },
  [SK.INVOICE_NUMBER_PREFIX]: {
    key: SK.INVOICE_NUMBER_PREFIX,
    section: 'client_invoicing',
    label: 'Invoice number prefix',
    description:
      'Optional prefix for new invoice numbers (e.g. "INV-"). Leave empty to disable.',
    type: 'string',
    default: 'INV-',
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },
  [SK.INVOICE_DEFAULT_NOTE]: {
    key: SK.INVOICE_DEFAULT_NOTE,
    section: 'client_invoicing',
    label: 'Default note',
    description: 'Note pre-filled on a new invoice.',
    type: 'string',
    default: '',
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },
  [SK.INVOICE_PAYMENT_INSTRUCTIONS]: {
    key: SK.INVOICE_PAYMENT_INSTRUCTIONS,
    section: 'client_invoicing',
    label: 'Payment instructions',
    description:
      'Bank/payment block printed on invoices. Does not include secret keys.',
    type: 'string',
    default: '',
    viewPermission: SETTINGS_VIEW,
    editPermission: INVOICING_EDIT,
  },

  // ── People & Time Off ──────────────────────────────────────────
  [SK.TIMEOFF_VACATION_DAYS_PER_YEAR]: {
    key: SK.TIMEOFF_VACATION_DAYS_PER_YEAR,
    section: 'people_time_off',
    label: 'Vacation days per year',
    description: 'How many paid vacation days each active employee accrues per year.',
    type: 'number',
    default: 21,
    min: 0,
    max: 60,
    unit: 'days',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.TIMEOFF_SICK_DAYS_PER_YEAR]: {
    key: SK.TIMEOFF_SICK_DAYS_PER_YEAR,
    section: 'people_time_off',
    label: 'Sick days per year',
    description: 'How many paid sick days each active employee accrues per year.',
    type: 'number',
    default: 5,
    min: 0,
    max: 60,
    unit: 'days',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.TIMEOFF_WORKING_WEEKDAYS]: {
    key: SK.TIMEOFF_WORKING_WEEKDAYS,
    section: 'people_time_off',
    label: 'Working weekdays',
    description:
      'Which weekdays count against time-off balances. Weekend days are skipped.',
    type: 'weekdays',
    default: [1, 2, 3, 4, 5],
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.TIMEOFF_ALLOW_NEGATIVE_BALANCE]: {
    key: SK.TIMEOFF_ALLOW_NEGATIVE_BALANCE,
    section: 'people_time_off',
    label: 'Allow negative balance',
    description:
      'When enabled, a request is still accepted when it exceeds the available balance — a warning is surfaced instead of a rejection.',
    type: 'boolean',
    default: true,
    dangerous: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },

  // ── Payroll & Compensation ─────────────────────────────────────
  // Payroll period is intentionally not configurable: payroll always
  // tracks the calendar month. The removed decorative setting lived
  // here as a reminder of that invariant.
  [SK.PAYROLL_FIXED_TAX]: {
    key: SK.PAYROLL_FIXED_TAX,
    section: 'payroll_compensation',
    label: 'Fixed tax component',
    description:
      'Flat tax amount subtracted from each employee payroll row. Applies to new/open runs; paid runs keep their snapshot.',
    type: 'number',
    default: 42.5,
    min: 0,
    max: 10000,
    step: 0.5,
    unit: '',
    viewPermission: OWNER_ONLY,
    editPermission: OWNER_ONLY,
  },
  [SK.PAYROLL_TAX_PERCENT]: {
    key: SK.PAYROLL_TAX_PERCENT,
    section: 'payroll_compensation',
    label: 'Tax percentage',
    description:
      'Percentage tax applied to each payroll row. Applies to new/open runs only.',
    type: 'percentage',
    default: 6,
    min: 0,
    max: 100,
    step: 0.1,
    viewPermission: OWNER_ONLY,
    editPermission: OWNER_ONLY,
  },
  [SK.PAYROLL_PAYONEER_FEE_PERCENT]: {
    key: SK.PAYROLL_PAYONEER_FEE_PERCENT,
    section: 'payroll_compensation',
    label: 'Payoneer fee',
    description:
      'Transfer fee applied on payout. Applies to new/open runs only.',
    type: 'percentage',
    default: 3,
    min: 0,
    max: 100,
    step: 0.1,
    viewPermission: OWNER_ONLY,
    editPermission: OWNER_ONLY,
  },
  [SK.PAYROLL_LOCK_PAID_RUNS]: {
    key: SK.PAYROLL_LOCK_PAID_RUNS,
    section: 'payroll_compensation',
    label: 'Lock paid runs',
    description: 'Prevent any edit to a payroll entry once it is marked Paid.',
    type: 'boolean',
    default: true,
    viewPermission: OWNER_ONLY,
    editPermission: OWNER_ONLY,
  },
  [SK.PAYROLL_ALLOW_OWNER_REOPEN]: {
    key: SK.PAYROLL_ALLOW_OWNER_REOPEN,
    section: 'payroll_compensation',
    label: 'Allow Owner to reopen a paid run',
    description:
      'When enabled, the Owner may reopen a Paid run back to Draft to correct a mistake. Admin Manager cannot.',
    type: 'boolean',
    default: true,
    viewPermission: OWNER_ONLY,
    editPermission: OWNER_ONLY,
  },

  // ── Credentials & Security ─────────────────────────────────────
  [SK.CREDENTIALS_VAULT_SESSION_MIN]: {
    key: SK.CREDENTIALS_VAULT_SESSION_MIN,
    section: 'credentials_security',
    label: 'Vault session duration',
    description:
      'How long a vault session stays unlocked after MFA. Shorter is more secure.',
    type: 'duration_minutes',
    default: 60,
    min: 5,
    max: 240,
    viewPermission: OWNER_ONLY,
    editPermission: OWNER_ONLY,
  },
  [SK.CREDENTIALS_REVEAL_AUTOHIDE_SEC]: {
    key: SK.CREDENTIALS_REVEAL_AUTOHIDE_SEC,
    section: 'credentials_security',
    label: 'Revealed field auto-hide',
    description:
      'Seconds before a revealed secret is auto-hidden in the UI.',
    type: 'duration_seconds',
    default: 60,
    min: 5,
    max: 600,
    viewPermission: OWNER_ONLY,
    editPermission: OWNER_ONLY,
  },
  [SK.CREDENTIALS_MAX_ATTACHMENT_MB]: {
    key: SK.CREDENTIALS_MAX_ATTACHMENT_MB,
    section: 'credentials_security',
    label: 'Maximum attachment size',
    description:
      'Hard limit on an uploaded attachment, in megabytes.',
    type: 'number',
    default: 10,
    min: 1,
    max: 100,
    unit: 'MB',
    viewPermission: OWNER_ONLY,
    editPermission: OWNER_ONLY,
  },

  // ── Phone Alerts ────────────────────────────────────────────────
  [SK.PHONE_ALERTS_ENABLED]: {
    key: SK.PHONE_ALERTS_ENABLED,
    section: 'phone_alerts',
    label: 'Daily Discord reminder',
    description:
      'Send a consolidated Discord message every day until all open phone maintenance tasks are completed.',
    type: 'boolean',
    default: false,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
    effectHint:
      'Off: scheduler stays silent. On: the daily job runs at the chosen time.',
  },
  [SK.PHONE_ALERTS_SEND_HOUR]: {
    key: SK.PHONE_ALERTS_SEND_HOUR,
    section: 'phone_alerts',
    label: 'Send hour',
    description:
      'Hour of the day (0-23) when the reminder goes out, in UTC.',
    type: 'number',
    default: 9,
    min: 0,
    max: 23,
    unit: 'h',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PHONE_ALERTS_SEND_MINUTE]: {
    key: SK.PHONE_ALERTS_SEND_MINUTE,
    section: 'phone_alerts',
    label: 'Send minute',
    description:
      'Minute of the hour (0-59) when the reminder goes out.',
    type: 'number',
    default: 0,
    min: 0,
    max: 59,
    unit: 'm',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PHONE_ALERTS_INCLUDE_DUE]: {
    key: SK.PHONE_ALERTS_INCLUDE_DUE,
    section: 'phone_alerts',
    label: 'Include DUE tasks',
    description:
      'Include tasks whose due date has arrived but is not yet past.',
    type: 'boolean',
    default: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PHONE_ALERTS_INCLUDE_OVERDUE]: {
    key: SK.PHONE_ALERTS_INCLUDE_OVERDUE,
    section: 'phone_alerts',
    label: 'Include OVERDUE tasks',
    description:
      'Include tasks whose due date has already passed.',
    type: 'boolean',
    default: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },

  // ── Phone Defaults ──────────────────────────────────────────────
  [SK.PHONE_DEFAULTS_TOPUP_AMOUNT]: {
    key: SK.PHONE_DEFAULTS_TOPUP_AMOUNT,
    section: 'phone_defaults',
    label: 'Default top-up amount',
    description:
      'Pre-filled top-up amount (₴) when completing a maintenance task.',
    type: 'number',
    default: 10,
    min: 0,
    max: 1000,
    step: 1,
    unit: '₴',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },

  // ── Portfolio ───────────────────────────────────────────────────
  [SK.PORTFOLIO_STORAGE_BUCKET]: {
    key: SK.PORTFOLIO_STORAGE_BUCKET,
    section: 'portfolio',
    label: 'Storage bucket',
    description:
      'Which configured object-storage bucket receives new portfolio assets. Existing assets stay where they were uploaded — this only affects new uploads.',
    type: 'select',
    default: 'CLIENT_REQUESTS',
    options: [
      { value: 'CLIENT_REQUESTS', label: 'Client requests bucket (shared)' },
      { value: 'INVOICES', label: 'Invoices bucket' },
    ],
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
    effectHint:
      'Applies to the next upload. Older assets keep their original bucket; swapping without migrating them breaks their download URLs.',
  },
  [SK.PORTFOLIO_SEPARATE_FOLDERS]: {
    key: SK.PORTFOLIO_SEPARATE_FOLDERS,
    section: 'portfolio',
    label: 'Separate folders per asset kind',
    description:
      'When on, new uploads land under `portfolio/<itemId>/covers|images|files/`. When off, everything goes flat under `portfolio/<itemId>/`.',
    type: 'boolean',
    default: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
    effectHint:
      'Easier to browse the bucket and target backups per kind. Does not touch existing files.',
  },
  [SK.PORTFOLIO_MAX_COVER_MB]: {
    key: SK.PORTFOLIO_MAX_COVER_MB,
    section: 'portfolio',
    label: 'Max cover image size',
    description: 'Hard limit on a single cover image upload.',
    type: 'number',
    default: 5,
    min: 1,
    max: 100,
    step: 1,
    unit: 'MB',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PORTFOLIO_MAX_GALLERY_ITEMS]: {
    key: SK.PORTFOLIO_MAX_GALLERY_ITEMS,
    section: 'portfolio',
    label: 'Max gallery images',
    description:
      'How many images one portfolio item may hold in its gallery.',
    type: 'number',
    default: 10,
    min: 1,
    max: 50,
    step: 1,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PORTFOLIO_MAX_GALLERY_MB]: {
    key: SK.PORTFOLIO_MAX_GALLERY_MB,
    section: 'portfolio',
    label: 'Max per gallery image size',
    description: 'Hard limit on each gallery image file.',
    type: 'number',
    default: 8,
    min: 1,
    max: 100,
    step: 1,
    unit: 'MB',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PORTFOLIO_MAX_FILES]: {
    key: SK.PORTFOLIO_MAX_FILES,
    section: 'portfolio',
    label: 'Max attached files',
    description:
      'How many non-image attachments one portfolio item may hold.',
    type: 'number',
    default: 10,
    min: 1,
    max: 50,
    step: 1,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PORTFOLIO_MAX_FILE_MB]: {
    key: SK.PORTFOLIO_MAX_FILE_MB,
    section: 'portfolio',
    label: 'Max per attachment size',
    description: 'Hard limit on each individual attachment.',
    type: 'number',
    default: 25,
    min: 1,
    max: 200,
    step: 1,
    unit: 'MB',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PORTFOLIO_MAX_FILES_TOTAL_MB]: {
    key: SK.PORTFOLIO_MAX_FILES_TOTAL_MB,
    section: 'portfolio',
    label: 'Attachments total budget',
    description:
      'Combined size cap for all attachments of one portfolio item.',
    type: 'number',
    default: 50,
    min: 1,
    max: 500,
    step: 5,
    unit: 'MB',
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PORTFOLIO_DEFAULT_STATUS]: {
    key: SK.PORTFOLIO_DEFAULT_STATUS,
    section: 'portfolio',
    label: 'Default status for new items',
    description:
      'Pre-selected status when creating a new portfolio item.',
    type: 'select',
    default: 'DRAFT',
    options: [
      { value: 'DRAFT', label: 'Draft' },
      { value: 'READY', label: 'Ready' },
    ],
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PORTFOLIO_AUTO_SLUG]: {
    key: SK.PORTFOLIO_AUTO_SLUG,
    section: 'portfolio',
    label: 'Auto-generate slug',
    description:
      'When on, the slug is derived from the title until the user edits it. When off, slug is always required manually.',
    type: 'boolean',
    default: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
  [SK.PORTFOLIO_PDF_EXPORT_ENABLED]: {
    key: SK.PORTFOLIO_PDF_EXPORT_ENABLED,
    section: 'portfolio',
    label: 'Enable PDF export',
    description:
      'Expose the `/portfolio/:slug/export` endpoint and the Export button in the UI.',
    type: 'boolean',
    default: true,
    viewPermission: SETTINGS_VIEW,
    editPermission: OWNER_ONLY,
  },
};

export const SECTIONS: Array<{
  key: RegistrySection;
  title: string;
  description: string;
  /** Permission required just to see the section at all. */
  viewPermission: string;
  /** True if Admin Manager loses access to this section entirely. */
  ownerOnlySection: boolean;
  order: number;
}> = [
  {
    key: 'general',
    title: 'General',
    description:
      'Workspace identity, timezone, currency and locale defaults.',
    viewPermission: SETTINGS_VIEW,
    ownerOnlySection: false,
    order: 10,
  },
  {
    key: 'scanner_alerts',
    title: 'Scanner & alerts',
    description:
      'Ingestion, automated analysis and Discord notifications for job posts.',
    viewPermission: SETTINGS_VIEW,
    ownerOnlySection: false,
    order: 20,
  },
  {
    key: 'client_invoicing',
    title: 'Client invoicing',
    description:
      'Issuer details, defaults and payment block used on new client invoices.',
    viewPermission: SETTINGS_VIEW,
    ownerOnlySection: false,
    order: 30,
  },
  {
    key: 'people_time_off',
    title: 'People & time off',
    description:
      'Vacation / sick balances, working weekdays and reset policy.',
    viewPermission: SETTINGS_VIEW,
    ownerOnlySection: false,
    order: 40,
  },
  {
    key: 'payroll_compensation',
    title: 'Payroll & compensation',
    description:
      'Tax coefficients, Payoneer fees and lock policy for paid runs.',
    viewPermission: OWNER_ONLY,
    ownerOnlySection: true,
    order: 50,
  },
  {
    key: 'credentials_security',
    title: 'Credentials & security',
    description:
      'Vault session, reveal auto-hide and attachment policy.',
    viewPermission: OWNER_ONLY,
    ownerOnlySection: true,
    order: 60,
  },
  {
    key: 'phone_alerts',
    title: 'Phone alerts',
    description:
      'Discord reminder for pending SIM maintenance tasks — webhook, time, scope and mention.',
    viewPermission: SETTINGS_VIEW,
    ownerOnlySection: false,
    order: 62,
  },
  {
    key: 'phone_defaults',
    title: 'Phone defaults',
    description:
      'Default values pre-filled on phone-related forms.',
    viewPermission: SETTINGS_VIEW,
    ownerOnlySection: false,
    order: 64,
  },
  {
    key: 'portfolio',
    title: 'Portfolio',
    description:
      'Where portfolio covers, gallery images and attachments live, plus hard limits for new uploads.',
    viewPermission: SETTINGS_VIEW,
    ownerOnlySection: false,
    order: 66,
  },
  {
    key: 'integrations',
    title: 'Integrations',
    description:
      'Live status of Vibe Worker and Discord integrations.',
    viewPermission: SETTINGS_VIEW,
    ownerOnlySection: false,
    order: 70,
  },
];

/* ─── Permission helpers ───────────────────────────────────────── */

export function hasPermission(
  userPerms: Set<string>,
  key: string,
): boolean {
  return userPerms.has(key);
}

/** True if any entry in the section is visible to this user. */
export function canSeeSection(
  userPerms: Set<string>,
  section: RegistrySection,
): boolean {
  const def = SECTIONS.find((s) => s.key === section);
  if (!def) return false;
  if (!hasPermission(userPerms, def.viewPermission)) return false;
  // Payroll + credentials sections are gated so hard that only
  // settings:update (Owner) covers them.
  return true;
}

export function canEditEntry(
  userPerms: Set<string>,
  entry: RegistryEntry,
): boolean {
  if (entry.readOnly || entry.sensitive) return false;
  return hasPermission(userPerms, entry.editPermission);
}

export function listEntriesForSection(section: RegistrySection) {
  return Object.values(SETTINGS_REGISTRY).filter((e) => e.section === section);
}

/* ─── Validation / coercion ────────────────────────────────────── */

export class RegistryValidationError extends Error {
  constructor(public readonly key: string, message: string) {
    super(`Setting "${key}": ${message}`);
  }
}

export function coerceAndValidate(
  entry: RegistryEntry,
  raw: unknown,
): unknown {
  switch (entry.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new RegistryValidationError(entry.key, 'must be a boolean');
    }
    case 'number':
    case 'duration_minutes':
    case 'duration_seconds':
    case 'percentage': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        throw new RegistryValidationError(entry.key, 'must be a number');
      }
      if (entry.min !== undefined && n < entry.min) {
        throw new RegistryValidationError(
          entry.key,
          `must be >= ${entry.min}`,
        );
      }
      if (entry.max !== undefined && n > entry.max) {
        throw new RegistryValidationError(
          entry.key,
          `must be <= ${entry.max}`,
        );
      }
      return n;
    }
    case 'string': {
      if (typeof raw !== 'string') {
        throw new RegistryValidationError(entry.key, 'must be a string');
      }
      return raw;
    }
    case 'select':
    case 'currency': {
      if (typeof raw !== 'string') {
        throw new RegistryValidationError(
          entry.key,
          'must be a string option',
        );
      }
      if (entry.options && !entry.options.find((o) => o.value === raw)) {
        throw new RegistryValidationError(
          entry.key,
          `must be one of: ${entry.options
            .map((o) => o.value)
            .join(', ')}`,
        );
      }
      return raw;
    }
    case 'weekdays': {
      if (!Array.isArray(raw)) {
        throw new RegistryValidationError(
          entry.key,
          'must be an array of weekday numbers',
        );
      }
      const nums = raw.map((v) => Number(v));
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
        throw new RegistryValidationError(
          entry.key,
          'weekday numbers must be between 0 (Sunday) and 6 (Saturday)',
        );
      }
      return Array.from(new Set(nums)).sort((a, b) => a - b);
    }
  }
}

/** Returns a safe value for runtime consumption. Falls back to the
 *  registry default when the stored value does not match the expected
 *  shape. Never throws. */
export function resolveSafe(
  entry: RegistryEntry,
  stored: unknown,
): unknown {
  try {
    if (stored === null || stored === undefined) return entry.default;
    return coerceAndValidate(entry, stored);
  } catch {
    return entry.default;
  }
}
