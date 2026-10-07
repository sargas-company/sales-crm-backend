import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

/**
 * Update is restricted to the two business-mutable fields. The row's
 * identity (`projectId`, `reportDate`), its source badge, its
 * Discord metadata, and its contributor snapshot are immutable
 * after create — see migration 20261023000000 for the model shift.
 */
export class UpdateProjectReportDto {
  @ApiPropertyOptional({ minimum: 0.1, maximum: 24 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(24)
  hours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  @Transform(({ value }) => trim(value))
  content?: string;
}
