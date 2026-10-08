import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
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

  @ApiProperty({
    description:
      'CRM Client this project is for. Required when creating a project; legacy rows may stay null.',
  })
  @IsUUID()
  crmClientId: string;

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
}
