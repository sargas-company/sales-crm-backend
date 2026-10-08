import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ClientType, LeadStatus } from '@prisma/client';

const E164_RE = /^\+[1-9]\d{1,14}$/;

const normaliseEmail = ({ value }: { value: unknown }): unknown => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
};

const normalisePhone = ({ value }: { value: unknown }): unknown => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const compact = value.replace(/\s+/g, '');
  return compact === '' ? null : compact;
};

export class UpdateLeadDto {
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
    description:
      'Contact email. Trimmed and lower-cased server-side. Send `null` to clear.',
  })
  @Transform(normaliseEmail)
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({
    example: '+14155550123',
    description:
      'Contact phone in E.164 format (`+` and 2-15 digits). Send `null` to clear.',
  })
  @Transform(normalisePhone)
  @IsOptional()
  @Matches(E164_RE, {
    message:
      'phone must be in international format starting with `+` and 2-15 digits',
  })
  phone?: string | null;

  @ApiPropertyOptional({ enum: LeadStatus, example: LeadStatus.trial })
  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

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
}
