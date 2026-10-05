import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  MaxLength,
} from 'class-validator';
import {
  LinkedInIdeaPriority,
  LinkedInIdeaStatus,
  LinkedInPostFormat,
} from '@prisma/client';

export class CreateLinkedInIdeaDto {
  @ApiProperty()
  @IsString()
  @MaxLength(240)
  title: string;

  @ApiProperty()
  @IsString()
  @MaxLength(20000)
  content: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  hook?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  targetAudience?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contentPillar?: string;

  @ApiPropertyOptional({ enum: LinkedInPostFormat })
  @IsOptional()
  @IsEnum(LinkedInPostFormat)
  suggestedFormat?: LinkedInPostFormat;

  @ApiPropertyOptional({ default: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  @ApiPropertyOptional({ enum: LinkedInIdeaPriority, default: LinkedInIdeaPriority.MEDIUM })
  @IsOptional()
  @IsEnum(LinkedInIdeaPriority)
  priority?: LinkedInIdeaPriority;

  @ApiPropertyOptional({ enum: LinkedInIdeaStatus, default: LinkedInIdeaStatus.NEW })
  @IsOptional()
  @IsEnum(LinkedInIdeaStatus)
  status?: LinkedInIdeaStatus;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUrl({ require_tld: false }, { each: true })
  referenceLinks?: string[];

  @ApiPropertyOptional({
    description: 'Array of {url, name?, type?} objects — kept as JSON blob.',
  })
  @IsOptional()
  attachments?: Array<{ url: string; name?: string; type?: string }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ example: '2026-11-15' })
  @IsOptional()
  @IsDateString()
  plannedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;
}
