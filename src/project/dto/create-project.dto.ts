import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus, ProjectType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = (v: unknown) =>
  typeof v === 'string' ? v.trim() || undefined : v;

export class CreateProjectDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Transform(({ value }) => trim(value))
  name: string;

  @ApiPropertyOptional({
    description:
      'Legacy — ties the project to a Counterparty row. Nullable and no longer required; new flow uses `crmClientId`. Counterparty module is otherwise untouched.',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({
    description:
      'CRM Client this project is for. Optional — owner may create and later re-assign; legacy rows stay null.',
  })
  @IsOptional()
  @IsUUID()
  crmClientId?: string;

  @ApiPropertyOptional({ enum: ProjectStatus, default: ProjectStatus.planned })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Transform(({ value }) => trim(value))
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Employee UUIDs to assign to this project.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  @Type(() => String)
  memberIds?: string[];

  @ApiPropertyOptional({
    description:
      'Discord channel id (snowflake). When set, `/report` from inside this channel creates a ProjectReport attributed to this project.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/^[0-9]{17,20}$/, {
    message: 'discordChannelId must be a Discord snowflake id',
  })
  discordChannelId?: string | null;

  // ─── Billing shape (all optional) ─────────────────────────────────
  // Cadence of `rate` is implied by `type`:
  //   HOURLY   → $/hour, `hoursBudget` is the optional cap.
  //   RETAINER → $/month, `hoursBudget` ignored.
  //   FIXED    → flat contract value, `hoursBudget` ignored.

  @ApiPropertyOptional({ enum: ProjectType })
  @IsOptional()
  @IsEnum(ProjectType)
  type?: ProjectType;

  @ApiPropertyOptional({
    description: 'Numeric rate; interpretation depends on `type`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999.99)
  rate?: number;

  @ApiPropertyOptional({ description: 'ISO-4217 currency, e.g. USD.' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() || undefined : value,
  )
  rateCurrency?: string;

  @ApiPropertyOptional({
    description:
      'Optional cap on billable hours — only meaningful when type=HOURLY.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  hoursBudget?: number;
}
