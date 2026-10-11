import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { EnableAnalysisStrategy } from './enable-analysis.dto';

/**
 * Read-only "what would happen" preview for the Resume AI modal.
 *
 * Does NOT change any state — no updateMany, no queue push, no
 * settings flip. Takes the same strategy + period inputs as
 * `enable-analysis` so the counts match what the real call will
 * do, modulo any posts that arrive between preview and submit.
 */
export class PreviewEnableAnalysisDto {
  @ApiProperty({ enum: EnableAnalysisStrategy })
  @IsEnum(EnableAnalysisStrategy)
  strategy: EnableAnalysisStrategy;

  @ApiPropertyOptional({
    description: 'Hours window for strategy=recent (1..720).',
    example: 24,
  })
  @IsOptional()
  @Transform(({ value }) => (value == null ? value : Number(value)))
  @IsInt()
  @Min(1)
  @Max(720)
  hours?: number;
}
