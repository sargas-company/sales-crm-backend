import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ClientType, LeadStatus, LeadTemperature } from '@prisma/client';

/**
 * E.164 phone format — a `+`, a non-zero country-code digit, up to
 * 14 more digits (max 15 total). Frontend parses raw input via
 * `libphonenumber-js` and sends the normalised E.164 form; the
 * backend accepts anything that fits this shape to stay provider-
 * agnostic (no hardcoded country).
 */
const E164_RE = /^\+[1-9]\d{1,14}$/;

/** Trim + lower-case for email; null-out empty strings. */
const normaliseEmail = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
};

/** Collapse all whitespace, convert `empty` → null. The E.164 regex
 *  takes care of the rest. */
const normalisePhone = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const compact = value.replace(/\s+/g, '');
  return compact === '' ? null : compact;
};

export class CreateLeadDto {
  @ApiPropertyOptional({ example: 'John' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  companyName?: string;

  @ApiPropertyOptional({
    example: 'john@acme.com',
    description: 'Contact email. Trimmed and lower-cased server-side.',
  })
  @Transform(normaliseEmail)
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({
    example: '+14155550123',
    description:
      'Contact phone in E.164 format (`+` followed by country code and digits).',
  })
  @Transform(normalisePhone)
  @IsOptional()
  @Matches(E164_RE, {
    message:
      'phone must be in international format starting with `+` and 2-15 digits',
  })
  phone?: string | null;

  @ApiPropertyOptional({ enum: ClientType, example: ClientType.individual })
  @IsOptional()
  @IsEnum(ClientType)
  clientType?: ClientType;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @IsInt()
  @Min(0)
  rate?: number;

  @ApiPropertyOptional({ example: 'United States' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  location?: string;

  @ApiPropertyOptional({ enum: LeadStatus, default: LeadStatus.NEW })
  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @ApiPropertyOptional({ enum: LeadTemperature })
  @IsOptional()
  @IsEnum(LeadTemperature)
  temperature?: LeadTemperature | null;

  @ApiPropertyOptional({ example: 'Upwork' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string | null;

  @ApiPropertyOptional({ example: 'https://upwork.com/freelancers/~abc' })
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: true })
  @MaxLength(500)
  profileUrl?: string | null;

  @ApiPropertyOptional({ example: 'Followed up on 2026-10-01, meeting Tue.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}
