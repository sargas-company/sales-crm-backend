import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export type SalesDateRangeKey = 'today' | '7d' | '30d' | 'custom';
export type ContractTypeFilter = 'fixed' | 'hourly' | 'unknown';
export type ManualRelevanceFilter =
  | 'relevant'
  | 'not_relevant'
  | 'very_relevant'
  | 'unrated';
export type NotificationStatusFilter =
  | 'sent'
  | 'failed'
  | 'not_required'
  | 'pending';

const csvToArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v)).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (typeof value === 'string') {
    const list = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  return undefined;
};

const toInt = ({ value }: { value: unknown }): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

export class AnalyticsFiltersDto {
  @IsOptional()
  @IsEnum(['today', '7d', '30d', 'custom'])
  dateRange?: SalesDateRangeKey;

  @IsOptional()
  @IsISO8601()
  customFrom?: string;

  @IsOptional()
  @IsISO8601()
  customTo?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(100)
  scoreMin?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(100)
  scoreMax?: number;

  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @IsString({ each: true })
  technology?: string[];

  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @IsString({ each: true })
  direction?: string[];

  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @IsString({ each: true })
  platformId?: string[];

  @IsOptional()
  @IsEnum(['fixed', 'hourly', 'unknown'])
  contractType?: ContractTypeFilter;

  @IsOptional()
  @IsString()
  budgetBucket?: string;

  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @IsString({ each: true })
  clientCountry?: string[];

  @IsOptional()
  @Transform(csvToArray)
  @IsArray()
  @IsString({ each: true })
  clientQuality?: string[];

  @IsOptional()
  @IsEnum(['relevant', 'not_relevant', 'very_relevant', 'unrated'])
  manualRelevance?: ManualRelevanceFilter;

  @IsOptional()
  @IsEnum(['sent', 'failed', 'not_required', 'pending'])
  notificationStatus?: NotificationStatusFilter;
}

export class ScannerHealthQueryDto {
  @IsOptional()
  @IsEnum(['today', '7d', '30d'])
  period?: 'today' | '7d' | '30d';
}

export class HeatmapQueryDto extends AnalyticsFiltersDto {
  @IsOptional()
  @IsEnum(['all', 'qualified', 'hot', 'qualifiedRate', 'averageScore'])
  metric?: 'all' | 'qualified' | 'hot' | 'qualifiedRate' | 'averageScore';
}

export class RecentPostsQueryDto extends AnalyticsFiltersDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class JobPostsPageQueryDto extends AnalyticsFiltersDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
