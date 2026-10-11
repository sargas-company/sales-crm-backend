import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export enum EnableAnalysisStrategy {
  ALL = 'all',
  RECENT = 'recent',
  NEW_POSTS_ONLY = 'new_posts_only',
  CANCEL = 'cancel',
}

class RecentWindow {
  @ApiProperty({ example: 24, description: 'Window size in hours (1..720).' })
  @IsInt()
  @Min(1)
  @Max(720)
  hours: number;
}

/**
 * Operator decision for the backlog of posts stored while AI was
 * paused. Strategies apply to the SNAPSHOT of BACKLOG rows at the
 * moment the call lands; posts arriving after that snapshot are
 * never collaterally marked SKIPPED by this call.
 *
 *   all              — flip every BACKLOG row to PENDING.
 *   recent{hours}    — recent-enough rows → PENDING; the rest → SKIPPED.
 *   new_posts_only   — every BACKLOG row → SKIPPED.
 *   cancel           — no state change; just flip the setting back on
 *                      (or leave off, see controller).
 */
export class EnableAnalysisDto {
  @ApiProperty({ enum: EnableAnalysisStrategy })
  @IsEnum(EnableAnalysisStrategy)
  strategy: EnableAnalysisStrategy;

  @ApiPropertyOptional({ type: RecentWindow })
  @ValidateIf((o: EnableAnalysisDto) => o.strategy === EnableAnalysisStrategy.RECENT)
  @ValidateNested()
  @Type(() => RecentWindow)
  @IsOptional()
  recent?: RecentWindow;
}
