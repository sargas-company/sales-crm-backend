import { ApiPropertyOptional } from '@nestjs/swagger';
import { RateType, SalaryReviewResult } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateSalaryReviewDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  scheduledDate?: string;

  @ApiPropertyOptional({ enum: RateType })
  @IsOptional()
  @IsEnum(RateType)
  previousRateType?: RateType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  previousRate?: number;

  @ApiPropertyOptional({ enum: RateType })
  @IsOptional()
  @IsEnum(RateType)
  newRateType?: RateType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  newRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;

  @ApiPropertyOptional({ enum: SalaryReviewResult })
  @IsOptional()
  @IsEnum(SalaryReviewResult)
  result?: SalaryReviewResult;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
