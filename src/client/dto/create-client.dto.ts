import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClientStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const E164_RE = /^\+[1-9]\d{1,14}$/;

const normaliseEmail = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  return value.trim().toLowerCase();
};

const normalisePhone = (value: unknown): string | undefined | null => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, '');
  if (!trimmed) return null;
  return trimmed;
};

const trim = (value: unknown): string | undefined | null => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Create-client DTO (rev-6 2026-10-22 — only identity is required):
 *
 * - firstName / lastName are REQUIRED. Everything else is optional —
 *   owner's decision to allow lightweight Client entries where
 *   only the person's name is known (company / email / phone etc.
 *   added later via edit).
 * - `platformId` and `clientSince` are deliberately absent — the UI
 *   stopped editing them; the backend columns stay to preserve
 *   existing data, but no write-path accepts them any more.
 * - `rate` was never a Client field (unlike Lead); kept here as a
 *   negative note so future readers don't look for it.
 */
export class CreateClientDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  firstName: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  lastName: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Transform(({ value }) => trim(value))
  company?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) => normaliseEmail(value))
  email?: string | null;

  @ApiPropertyOptional({ description: 'Phone in E.164, e.g. +14155550123' })
  @IsOptional()
  @Matches(E164_RE, {
    message: 'phone must be in E.164 format, e.g. +14155550123',
  })
  @Transform(({ value }) => normalisePhone(value))
  phone?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => trim(value))
  source?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: true })
  @MaxLength(500)
  @Transform(({ value }) => trim(value))
  profileUrl?: string | null;

  @ApiPropertyOptional({ enum: ClientStatus, default: ClientStatus.ACTIVE })
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Transform(({ value }) => trim(value))
  notes?: string | null;

  @ApiPropertyOptional({
    description:
      'Free-text location — country name or "City, Country". The UI edits country and city separately and joins them here.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Transform(({ value }) => trim(value))
  location?: string | null;
}
