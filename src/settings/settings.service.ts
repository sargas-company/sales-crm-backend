import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Setting, SettingType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SettingKey } from './setting-keys';

const SECRET_MASK = '***';
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

type SettingWithValue = Setting & {
  value: { value: unknown } | null;
};

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  // ─── Admin / UI methods ──────────────────────────────────────────────────────

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
      settings: section.settings.map((s) => this.formatSetting(s)),
    }));
  }

  async getSetting(key: string) {
    const setting = await this.prisma.setting.findUnique({
      where: { key },
      include: { section: true, value: true },
    });

    if (!setting || !setting.isActive)
      throw new NotFoundException(`Setting "${key}" not found`);

    return this.formatSetting(setting);
  }

  async setSetting(key: string, raw: unknown) {
    const setting = await this.prisma.setting.findUnique({ where: { key } });

    // TODO: replace isActive=false workaround with isInternal field on Setting model
    if (!setting || (!setting.isActive && !this.isInternalKey(key)))
      throw new NotFoundException(`Setting "${key}" not found`);

    const coerced = this.coerceAndValidate(setting, raw);

    await this.prisma.settingValue.upsert({
      where: { settingId: setting.id },
      create: {
        settingId: setting.id,
        value: coerced as Prisma.InputJsonValue,
      },
      update: { value: coerced as Prisma.InputJsonValue },
    });

    this.invalidateCache(key);
    this.logger.log(`Setting "${key}" updated`);
  }

  // ─── Read: no side effects ───────────────────────────────────────────────────

  /**
   * Returns the current value or defaultValue.
   * Returns null (with warning) if the Setting row is missing entirely.
   * Never writes to DB.
   */
  async getRawValue(key: SettingKey): Promise<unknown> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const setting = await this.findSettingWithValue(key);

    if (!setting) {
      this.logger.warn(`getRawValue: Setting "${key}" not found`);
      this.cacheSet(key, null);
      return null;
    }

    const value = this.resolveValue(setting);
    this.cacheSet(key, value);
    return value;
  }

  // ─── Read: self-healing ──────────────────────────────────────────────────────

  /**
   * Same as getRawValue, but if no SettingValue exists and defaultValue is set,
   * persists the defaultValue to DB so subsequent reads are consistent.
   */
  async getValue(key: SettingKey): Promise<unknown> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const setting = await this.findSettingWithValue(key);

    if (!setting) {
      this.logger.warn(`getValue: Setting "${key}" not found`);
      this.cacheSet(key, null);
      return null;
    }

    if (setting.value !== null) {
      const value = setting.value.value;
      this.cacheSet(key, value);
      return value;
    }

    const defaultVal = setting.defaultValue ?? null;

    if (defaultVal !== null) {
      this.logger.log(`Self-healing: persisting defaultValue for "${key}"`);
      try {
        await this.prisma.settingValue.create({
          data: {
            settingId: setting.id,
            value: defaultVal,
          },
        });
      } catch (err) {
        const isUniqueViolation = (err as { code?: string }).code === 'P2002';

        if (!isUniqueViolation) {
          this.logger.error(`Self-healing write failed for "${key}"`, err);
          return null;
        }
      }
    }

    this.cacheSet(key, defaultVal);
    return defaultVal;
  }

  // ─── Typed accessors ─────────────────────────────────────────────────────────

  async getBoolean(key: SettingKey, fallback: boolean): Promise<boolean> {
    const value = await this.getValue(key);
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      this.logger.warn(
        `Setting "${key}": expected boolean, got ${typeof value} — using fallback`,
      );
      return fallback;
    }
    return value;
  }

  async getNumber(key: SettingKey, fallback: number): Promise<number> {
    const value = await this.getValue(key);
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'number') {
      this.logger.warn(
        `Setting "${key}": expected number, got ${typeof value} — using fallback`,
      );
      return fallback;
    }
    return value;
  }

  async getString(key: SettingKey, fallback: string): Promise<string> {
    const value = await this.getValue(key);
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') {
      this.logger.warn(
        `Setting "${key}": expected string, got ${typeof value} — using fallback`,
      );
      return fallback;
    }
    return value;
  }

  async getJson<T>(key: SettingKey, fallback: T): Promise<T> {
    const value = await this.getValue(key);
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'object') {
      this.logger.warn(
        `Setting "${key}": expected JSON, got ${typeof value} — using fallback`,
      );
      return fallback;
    }
    return value as T;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  // TODO: replace with isInternal field on Setting model
  private isInternalKey(key: string): boolean {
    return key === SettingKey.JOB_SCANNER_TELEGRAM_AUTH_HASH;
  }

  private async findSettingWithValue(
    key: string,
  ): Promise<SettingWithValue | null> {
    return this.prisma.setting.findUnique({
      where: { key },
      include: { value: true },
    }) as Promise<SettingWithValue | null>;
  }

  private cacheSet(key: string, value: unknown): void {
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private invalidateCache(key: string): void {
    this.cache.delete(key);
  }

  private formatSetting(setting: SettingWithValue) {
    const resolved = this.resolveValue(setting);
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

  private resolveValue(setting: SettingWithValue): unknown {
    if (setting.value !== null) return setting.value.value;
    return setting.defaultValue ?? null;
  }

  private coerceAndValidate(setting: Setting, raw: unknown): unknown {
    switch (setting.type) {
      case SettingType.string: {
        if (typeof raw !== 'string')
          throw new BadRequestException(
            `Setting "${setting.key}" expects a string`,
          );
        return raw;
      }
      case SettingType.number: {
        const n = Number(raw);
        if (isNaN(n))
          throw new BadRequestException(
            `Setting "${setting.key}" expects a number`,
          );
        const schema = setting.validationSchema as {
          min?: number;
          max?: number;
        } | null;
        if (schema?.min !== undefined && n < schema.min)
          throw new BadRequestException(
            `Setting "${setting.key}" must be >= ${schema.min}`,
          );
        if (schema?.max !== undefined && n > schema.max)
          throw new BadRequestException(
            `Setting "${setting.key}" must be <= ${schema.max}`,
          );
        return n;
      }
      case SettingType.boolean: {
        if (typeof raw === 'boolean') return raw;
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        throw new BadRequestException(
          `Setting "${setting.key}" expects a boolean`,
        );
      }
      case SettingType.json: {
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
}
