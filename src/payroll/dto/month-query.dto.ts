import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class MonthQueryDto {
  @ApiProperty({ example: 2026 })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiProperty({ example: 9 })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;
}
