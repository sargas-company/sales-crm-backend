import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RateType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePayrollDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: 2026 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiProperty({ example: 9 })
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @ApiProperty({ enum: RateType })
  @IsEnum(RateType)
  rateType: RateType;

  @ApiProperty({ description: 'HOURLY: per-hour rate. MONTHLY: monthly rate.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate: number;

  @ApiPropertyOptional({ description: 'Required for HOURLY.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  hours?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  bonusPercent?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  fixedBonus?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  advance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
