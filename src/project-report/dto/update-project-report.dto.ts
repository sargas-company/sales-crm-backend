import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

export class UpdateProjectReportDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  reportDate?: string;

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
