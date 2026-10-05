import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class YearQueryDto {
  @ApiPropertyOptional({ description: 'Calendar year (defaults to today).' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

export class CalendarQueryDto extends YearQueryDto {
  @ApiPropertyOptional({ description: 'Month 1-12 (defaults to current).' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({ description: 'Employee-name substring filter.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;
}
