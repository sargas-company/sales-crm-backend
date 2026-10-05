import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class AnalyticsQueryDto {
  @ApiProperty({
    required: false,
    description:
      'Fiscal year for the monthly-history chart and year-overview block (defaults to the current year).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year?: number;

  @ApiProperty({
    required: false,
    description: 'Range start (ISO date) — applied to Revenue-by-project / -client / -status blocks.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiProperty({ required: false, description: 'Range end (ISO date).' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiProperty({ required: false, description: 'Client (counterparty) id filter.' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({
    required: false,
    description:
      'Scope preset applied to the "current period" numbers. If from/to are provided, they override this.',
    enum: ['thisMonth', 'last3Months', 'thisYear', 'allTime', 'custom'],
  })
  @IsOptional()
  @IsString()
  scope?: 'thisMonth' | 'last3Months' | 'thisYear' | 'allTime' | 'custom';
}
