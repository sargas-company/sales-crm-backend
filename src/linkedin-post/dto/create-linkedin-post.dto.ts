import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LinkedInPostFormat, LinkedInPostStatus } from '@prisma/client';
import { LinkedInPostAttachmentDto } from './linkedin-post-attachment.dto';

export class CreateLinkedInPostDto {
  @ApiProperty()
  @IsString()
  @MaxLength(240)
  internalTitle: string;

  @ApiProperty()
  @IsUUID()
  accountId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ideaId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  authorId?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(20000)
  body: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  hook?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  firstComment?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hashtags?: string[];

  @ApiPropertyOptional({ enum: LinkedInPostFormat, default: LinkedInPostFormat.TEXT })
  @IsOptional()
  @IsEnum(LinkedInPostFormat)
  format?: LinkedInPostFormat;

  @ApiPropertyOptional({ default: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

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

  @ApiPropertyOptional({
    type: [LinkedInPostAttachmentDto],
    description: 'Array of {url, name?, type?} objects — kept as JSON blob.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LinkedInPostAttachmentDto)
  attachments?: LinkedInPostAttachmentDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(1000)
  externalLink?: string;

  @ApiPropertyOptional({ enum: LinkedInPostStatus, default: LinkedInPostStatus.DRAFT })
  @IsOptional()
  @IsEnum(LinkedInPostStatus)
  status?: LinkedInPostStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  publishedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: true })
  @MaxLength(1000)
  linkedInUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  // Manual performance metrics.
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) impressions?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) reactions?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) comments?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) reposts?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) clicks?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) followersGained?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) leadsGenerated?: number;
}
