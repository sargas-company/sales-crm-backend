import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RateType, SalaryReviewResult } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSalaryReviewDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ description: 'When the review was/should be conducted (YYYY-MM-DD).' })
  @IsDateString()
  scheduledDate: string;

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

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, required if result is INCREASED.' })
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
