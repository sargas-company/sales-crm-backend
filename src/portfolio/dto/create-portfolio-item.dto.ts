import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PortfolioStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = (v: unknown) =>
  typeof v === 'string' ? v.trim() : v;

const trimStrings = (v: unknown) => {
  if (!Array.isArray(v)) return v;
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : x))
    .filter((x) => typeof x === 'string' && x.length > 0);
};

/**
 * Portfolio-item create payload. Shape matches the frontend
 * `createPortfolioItem` mutation in
 * `sales-crm-frontend/src/store/portfolio/portfolioApi.ts`.
 */
export class CreatePortfolioItemDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({
    description:
      'URL-safe slug. When auto-slug is enabled this may be omitted.',
    maxLength: 160,
  })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'slug must be lowercase letters, digits or dashes',
  })
  slug?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MaxLength(500)
  shortSummary?: string;

  @ApiPropertyOptional({ enum: PortfolioStatus })
  @IsOptional()
  @IsEnum(PortfolioStatus)
  status?: PortfolioStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isNda?: boolean;

  @ApiPropertyOptional({ maxLength: 100_000 })
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  contentMarkdown?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 32 })
  @IsOptional()
  @Transform(({ value }) => trimStrings(value))
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @Type(() => String)
  tags?: string[];
}
