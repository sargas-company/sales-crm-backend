import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Setting } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SettingKey } from './setting-keys';
import {
  RegistryEntry,
  SETTINGS_REGISTRY,
  SECTIONS,
  RegistryValidationError,
  coerceAndValidate,
  resolveSafe,
  canSeeSection,
  canEditEntry,
  listEntriesForSection,
  RegistrySection,
} from './settings-registry';

const SECRET_MASK = '***';
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * SettingsService wraps the Setting / SettingValue rows and the
 * typed Registry. The Registry is the source of truth for every
 * known key (type, defaults, validation, permissions). The DB
 * stores the override value only.
 *
 * Runtime consumers (scanner, invoice, time-off, payroll,
 * credentials) call `getValueForKey(key)` which falls back to the
 * registry default when the stored value is missing or invalid.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  // ─── Legacy accessors (back-compat with existing callers) ────────────────────

  async getAllSettings() {
    const sections = await this.prisma.settingSection.findMany({
      orderBy: { order: 'asc' },
      include: {
        settings: {
          where: { isActive: true },
          orderBy: { order: 'asc' },
          include: { value: true },
        },
      },
    });
    return sections.map((section) => ({
      key: section.key,
      title: section.title,
      order: section.order,
      settings: section.settings.map((s) => this.formatLegacy(s)),
    }));
  }

  async getSetting(key: string) {
    const setting = await this.prisma.setting.findUnique({
      where: { key },
      include: { section: true, value: true },
    });
    if (!setting || !setting.isActive)
      throw new NotFoundException(`Setting "${key}" not found`);
    return this.formatLegacy(setting);
  }

  // ─── Registry-based accessors ────────────────────────────────────────────────

  /**
   * Returns the resolved value for one registry key. Falls back to
   * the registry default when the DB value is missing or malformed.
   * Never throws, never writes.
   */
  async getValueForKey<K extends string>(key: K): Promise<unknown> {
    const entry = SETTINGS_REGISTRY[key];
    if (!entry) {
      this.logger.warn(`Unknown registry key "${key}"`);
      return null;
    }
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await this.prisma.setting.findUnique({
      where: { key },
      include: { value: true },
    });
    const stored = row?.value?.value ?? null;
    const resolved = resolveSafe(entry, stored);
    this.cacheSet(key, resolved);
    return resolved;
  }

  async getBooleanForKey(key: string, fallback: boolean): Promise<boolean> {
    const v = await this.getValueForKey(key);
    return typeof v === 'boolean' ? v : fallback;
  }

  async getNumberForKey(key: string, fallback: number): Promise<number> {
    const v = await this.getValueForKey(key);
    return typeof v === 'number' ? v : fallback;
  }

  async getStringForKey(key: string, fallback: string): Promise<string> {
    const v = await this.getValueForKey(key);
    return typeof v === 'string' ? v : fallback;
  }

  // ─── Registry listing / sections ──────────────────────────────────────────────

  /**
   * Returns every section visible to the given user, with every
   * entry already resolved and marked with `canEdit`. Sections the
   * user cannot see are filtered out entirely; they do not appear
   * in the response.
   */
  async listSectionsFor(userPermissions: Set<string>) {
    const result: Array<{
      key: RegistrySection;
      title: string;
      description: string;
      order: number;
      ownerOnly: boolean;
      entries: Array<{
        key: string;
        label: string;
        description: string;
        type: RegistryEntry['type'];
        value: unknown;
        source: 'db' | 'default';
        canEdit: boolean;
        readOnly: boolean;
        dangerous: boolean;
        options?: RegistryEntry['options'];
        min?: number;
        max?: number;
        step?: number;
        unit?: string;
        effectHint?: string;
        updatedAt?: string | null;
        updatedBy?: string | null;
      }>;
    }> = [];

    const allRows = await this.prisma.setting.findMany({
      include: { value: true },
    });
    const byKey = new Map(allRows.map((r) => [r.key, r]));

    for (const section of [...SECTIONS].sort((a, b) => a.order - b.order)) {
      if (!canSeeSection(userPermissions, section.key)) continue;
      // Payroll + credentials require OWNER_ONLY which is already the
      // section-level viewPermission; nothing extra to add.
      const entries = listEntriesForSection(section.key)
        .filter((e) => userPermissions.has(e.viewPermission))
        .map((e) => {
          const row = byKey.get(e.key);
          const stored = row?.value?.value ?? null;
          const value = resolveSafe(e, stored);
          const source: 'db' | 'default' = row?.value ? 'db' : 'default';
          return {
            key: e.key,
            label: e.label,
            description: e.description,
            type: e.type,
            value,
            source,
            canEdit: canEditEntry(userPermissions, e),
            readOnly: !!e.readOnly,
            dangerous: !!e.dangerous,
            options: e.options,
            min: e.min,
            max: e.max,
            step: e.step,
            unit: e.unit,
            effectHint: e.effectHint,
            updatedAt: row?.value?.updatedAt?.toISOString() ?? null,
            updatedBy: null,
          };
        });
      if (entries.length === 0 && section.key !== 'integrations') continue;
      result.push({
        key: section.key,
        title: section.title,
        description: section.description,
        order: section.order,
        ownerOnly: section.ownerOnlySection,
        entries,
      });
    }
    return result;
  }

  /**
   * Update one or more keys from the same section. Validates each
   * key through the Registry; rejects unknown keys, keys outside
   * the user's edit permission, read-only entries and sensitive
   * entries.
   */
  async applySectionUpdate(
    sectionKey: RegistrySection,
    patch: Record<string, unknown>,
    userPermissions: Set<string>,
  ): Promise<{ changes: Record<string, { before: unknown; after: unknown }> }> {
    const section = SECTIONS.find((s) => s.key === sectionKey);
    if (!section) {
      throw new BadRequestException(`Unknown section "${sectionKey}"`);
    }
    if (!canSeeSection(userPermissions, sectionKey)) {
      throw new BadRequestException('Section is not accessible');
    }

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const [key, raw] of Object.entries(patch)) {
      const entry = SETTINGS_REGISTRY[key];
      if (!entry) {
        throw new BadRequestException(`Unknown setting key "${key}"`);
      }
      if (entry.section !== sectionKey) {
        throw new BadRequestException(
          `Setting "${key}" does not belong to section "${sectionKey}"`,
        );
      }
      if (!canEditEntry(userPermissions, entry)) {
        throw new BadRequestException(
          `Setting "${key}" is not editable with current permissions`,
        );
      }
      let coerced: unknown;
      try {
        coerced = coerceAndValidate(entry, raw);
      } catch (err) {
        if (err instanceof RegistryValidationError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }

      const existing = await this.prisma.setting.findUnique({
        where: { key },
        include: { value: true },
      });
      const before =
        existing?.value?.value ?? entry.default;

      // Guard: enabling scanner.analysisEnabled directly from the
      // Settings page would bypass the operator's choice for the
      // accumulated BACKLOG (Process vs Skip). Force that path
      // through POST /job-posts/enable-analysis — a Settings PATCH
      // may only turn the flag OFF or keep it at the current value.
      if (
        key === 'scanner.analysisEnabled' &&
        before === false &&
        coerced === true
      ) {
        throw new BadRequestException(
          'Enable AI analysis through the Resume AI dialog in Sales Analytics ' +
            '— a direct Settings toggle would leave accumulated posts in BACKLOG. ' +
            'Pausing AI from Settings is still allowed.',
        );
      }

      await this.ensureDbRow(entry);
      const row = await this.prisma.setting.findUnique({
        where: { key },
        select: { id: true },
      });
      if (!row) continue; // ensureDbRow failed silently; skip
      await this.prisma.settingValue.upsert({
        where: { settingId: row.id },
        create: {
          settingId: row.id,
          value: coerced as Prisma.InputJsonValue,
        },
        update: { value: coerced as Prisma.InputJsonValue },
      });
      this.invalidateCache(key);
      // Only include changes that actually changed (not a no-op).
      if (JSON.stringify(before) !== JSON.stringify(coerced)) {
        changes[key] = { before, after: coerced };
      }
    }
    return { changes };
  }

  // ─── Legacy fallback writer (kept so old /settings/:key keeps working) ──────

  async setSetting(key: string, raw: unknown) {
    const entry = SETTINGS_REGISTRY[key];
    if (entry) {
      // Route through registry validation for known keys.
      const coerced = coerceAndValidate(entry, raw);
      await this.ensureDbRow(entry);
      const row = await this.prisma.setting.findUnique({
        where: { key },
        select: { id: true },
      });
      if (!row) throw new NotFoundException(`Setting "${key}" not found`);
      const existing = await this.prisma.settingValue.findUnique({
        where: { settingId: row.id },
      });
      const before = existing?.value ?? entry.default;
      if (
        key === 'scanner.analysisEnabled' &&
        before === false &&
        coerced === true
      ) {
        throw new BadRequestException(
          'Enable AI analysis through the Resume AI dialog in Sales Analytics ' +
            '— a direct Settings toggle would leave accumulated posts in BACKLOG. ' +
            'Pausing AI from Settings is still allowed.',
        );
      }
      await this.prisma.settingValue.upsert({
        where: { settingId: row.id },
        create: {
          settingId: row.id,
          value: coerced as Prisma.InputJsonValue,
        },
        update: { value: coerced as Prisma.InputJsonValue },
      });
      this.invalidateCache(key);
      return;
    }
    // Legacy row-only path: respects the old DB-stored type.
    const setting = await this.prisma.setting.findUnique({ where: { key } });
    if (!setting || !setting.isActive)
      throw new NotFoundException(`Setting "${key}" not found`);
    const coerced = this.coerceLegacy(setting, raw);
    await this.prisma.settingValue.upsert({
      where: { settingId: setting.id },
      create: {
        settingId: setting.id,
        value: coerced as Prisma.InputJsonValue,
      },
      update: { value: coerced as Prisma.InputJsonValue },
    });
    this.invalidateCache(key);
  }

  // ─── Legacy typed accessors kept for existing callers ───────────────────────

  async getBoolean(key: SettingKey, fallback: boolean): Promise<boolean> {
    const value = await this.getRawValueLegacy(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  async getNumber(key: SettingKey, fallback: number): Promise<number> {
    const value = await this.getRawValueLegacy(key);
    return typeof value === 'number' ? value : fallback;
  }

  async getString(key: SettingKey, fallback: string): Promise<string> {
    const value = await this.getRawValueLegacy(key);
    return typeof value === 'string' ? value : fallback;
  }

  async getJson<T>(key: SettingKey, fallback: T): Promise<T> {
    const value = await this.getRawValueLegacy(key);
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'object') return fallback;
    return value as T;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async ensureDbRow(entry: RegistryEntry) {
    const existing = await this.prisma.setting.findUnique({
      where: { key: entry.key },
      select: { id: true },
    });
    if (existing) return;
    // Pick-or-create a section row to keep the DB foreign key valid.
    const section = await this.prisma.settingSection.upsert({
      where: { key: entry.section },
      update: {
        title: this.sectionTitle(entry.section),
      },
      create: {
        key: entry.section,
        title: this.sectionTitle(entry.section),
      },
    });
    try {
      await this.prisma.setting.create({
        data: {
          key: entry.key,
          sectionId: section.id,
          type: this.legacyDbType(entry),
          title: entry.label,
          description: entry.description,
          isActive: true,
          isSecret: !!entry.sensitive,
          isRequired: false,
          order: 0,
          defaultValue: entry.default as Prisma.InputJsonValue,
          uiType: this.legacyUiType(entry),
        },
      });
    } catch (err) {
      this.logger.warn(
        `ensureDbRow: failed to create Setting row for "${entry.key}"`,
        err,
      );
    }
  }

  private sectionTitle(key: RegistrySection) {
    return SECTIONS.find((s) => s.key === key)?.title ?? key;
  }

  private legacyDbType(entry: RegistryEntry): 'string' | 'number' | 'boolean' | 'json' {
    if (entry.type === 'boolean') return 'boolean';
    if (
      entry.type === 'number' ||
      entry.type === 'duration_minutes' ||
      entry.type === 'duration_seconds' ||
      entry.type === 'percentage'
    )
      return 'number';
    if (entry.type === 'weekdays') return 'json';
    return 'string';
  }

  private legacyUiType(
    entry: RegistryEntry,
  ): 'input' | 'textarea' | 'select' | 'toggle' | 'password' {
    if (entry.type === 'boolean') return 'toggle';
    if (entry.type === 'select' || entry.type === 'currency') return 'select';
    return 'input';
  }

  private cacheSet(key: string, value: unknown): void {
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private invalidateCache(key: string): void {
    this.cache.delete(key);
  }

  /**
   * In-cache invalidation hook for callers that wrote the setting
   * value from inside their own `$transaction` (via
   * `applyBooleanInsideTx`). Call AFTER the transaction has
   * committed — otherwise a concurrent read could re-populate the
   * cache from a row that then rolls back.
   */
  invalidateCachePublic(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Reads a boolean setting under a `FOR SHARE` row-level lock on
   * the Setting row, bypassing the in-process cache. Compatible
   * with `applyBooleanInsideTx` (which holds `FOR UPDATE`): a
   * writer with FOR UPDATE blocks concurrent readers acquiring
   * FOR SHARE until the writer commits, so a reader never sees
   * the pre-commit value of an in-flight flag flip. Multiple
   * concurrent readers do NOT block each other.
   *
   * Use ONLY inside a caller-controlled transaction that also
   * does the row-level DB work the flag gates (e.g. the ingestion
   * processor's JobPost create). Do NOT use for display reads —
   * `getBooleanForKey` is faster and the cache staleness is
   * acceptable there.
   *
   *   1. find the Setting row id (unlocked read of a stable id);
   *   2. take `FOR SHARE` on that id — blocks on any concurrent
   *      FOR UPDATE from an enable writer;
   *   3. only AFTER the lock is held, read SettingValue — this
   *      yields the committed value of a writer that was in
   *      flight when the caller arrived.
   */
  async getBooleanInsideTx(
    tx: Prisma.TransactionClient,
    key: string,
    fallback: boolean,
  ): Promise<boolean> {
    const row = await tx.setting.findUnique({
      where: { key },
      select: { id: true },
    });
    if (!row) return fallback;
    await tx.$executeRaw`SELECT 1 FROM "Setting" WHERE "id" = ${row.id} FOR SHARE`;
    const value = await tx.settingValue.findUnique({
      where: { settingId: row.id },
      select: { value: true },
    });
    if (!value) return fallback;
    const v = value.value;
    if (typeof v === 'boolean') return v;
    // Legacy rows that stored booleans as 'true'/'false' strings.
    if (typeof v === 'string') return v === 'true';
    return fallback;
  }

  /**
   * Read + exclusive-lock a boolean setting in ONE step. Use this
   * from code paths that both READ the current value AND intend
   * to WRITE a new one in the same transaction (e.g. enableAnalysis).
   *
   * Why not pair `getBooleanInsideTx` (FOR SHARE) with a later
   * `applyBooleanInsideTx` (FOR UPDATE)? Two parallel transactions
   * acquiring FOR SHARE first and then trying to upgrade to
   * FOR UPDATE will deadlock, because Postgres treats the upgrade
   * as a conflicting lock mode when another FOR SHARE is already
   * held. Taking FOR UPDATE from the start avoids that cycle: the
   * second transaction simply blocks until the first commits, then
   * reads the committed value.
   */
  async getBooleanForUpdateInsideTx(
    tx: Prisma.TransactionClient,
    key: string,
    fallback: boolean,
  ): Promise<boolean> {
    const row = await tx.setting.findUnique({
      where: { key },
      select: { id: true },
    });
    if (!row) return fallback;
    await tx.$executeRaw`SELECT 1 FROM "Setting" WHERE "id" = ${row.id} FOR UPDATE`;
    const value = await tx.settingValue.findUnique({
      where: { settingId: row.id },
      select: { value: true },
    });
    if (!value) return fallback;
    const v = value.value;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true';
    return fallback;
  }

  /**
   * Writes a boolean setting inside a caller-controlled Prisma
   * transaction. Lets a feature endpoint atomically pair a flag
   * flip with other row-level work (e.g. the enable-analysis
   * strategy for Job Posts).
   *
   *   - Serialises concurrent writers via SELECT … FOR UPDATE on
   *     the Setting row (if present).
   *   - Does NOT touch the in-process cache; the caller must call
   *     `invalidateCachePublic(key)` after a successful commit.
   *   - Falls back to legacy-row behaviour when the key is not
   *     in the registry.
   */
  async applyBooleanInsideTx(
    tx: Prisma.TransactionClient,
    key: string,
    value: boolean,
  ): Promise<void> {
    // Ensure the Setting row exists (idempotent) BEFORE opening
    // the row-level lock, so a brand-new local DB doesn't deadlock
    // on the first write.
    const entry = SETTINGS_REGISTRY[key];
    if (entry) {
      await this.ensureDbRow(entry);
    }
    const row = await tx.setting.findUnique({
      where: { key },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException(`Setting "${key}" not found`);
    }
    // Row-level lock to serialise concurrent enable/disable calls.
    await tx.$executeRaw`SELECT 1 FROM "Setting" WHERE "id" = ${row.id} FOR UPDATE`;
    await tx.settingValue.upsert({
      where: { settingId: row.id },
      create: { settingId: row.id, value: value as Prisma.InputJsonValue },
      update: { value: value as Prisma.InputJsonValue },
    });
  }

  private async getRawValueLegacy(key: string): Promise<unknown> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const row = await this.prisma.setting.findUnique({
      where: { key },
      include: { value: true },
    });
    if (!row) {
      this.cacheSet(key, null);
      return null;
    }
    const value = row.value?.value ?? row.defaultValue ?? null;
    this.cacheSet(key, value);
    return value;
  }

  private formatLegacy(setting: Setting & { value: { value: unknown } | null }) {
    const resolved = setting.value?.value ?? setting.defaultValue ?? null;
    const displayValue = setting.isSecret
      ? resolved !== null && resolved !== undefined
        ? SECRET_MASK
        : undefined
      : resolved;
    return {
      key: setting.key,
      title: setting.title,
      description: setting.description,
      type: setting.type,
      uiType: setting.uiType,
      isSecret: setting.isSecret,
      isRequired: setting.isRequired,
      order: setting.order,
      options: setting.options,
      validationSchema: setting.validationSchema,
      defaultValue: setting.isSecret ? undefined : setting.defaultValue,
      value: displayValue,
    };
  }

  private coerceLegacy(setting: Setting, raw: unknown): unknown {
    switch (setting.type) {
      case 'string':
        if (typeof raw !== 'string')
          throw new BadRequestException(
            `Setting "${setting.key}" expects a string`,
          );
        return raw;
      case 'number': {
        const n = Number(raw);
        if (isNaN(n))
          throw new BadRequestException(
            `Setting "${setting.key}" expects a number`,
          );
        return n;
      }
      case 'boolean':
        if (typeof raw === 'boolean') return raw;
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        throw new BadRequestException(
          `Setting "${setting.key}" expects a boolean`,
        );
      case 'json':
        if (typeof raw === 'object' && raw !== null) return raw;
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw);
          } catch {
            throw new BadRequestException(
              `Setting "${setting.key}" expects valid JSON`,
            );
          }
        }
        throw new BadRequestException(
          `Setting "${setting.key}" expects a JSON value`,
        );
    }
  }
}
