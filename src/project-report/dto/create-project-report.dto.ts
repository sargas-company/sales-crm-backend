import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

export class CreateProjectReportDto {
  @ApiProperty()
  @IsUUID()
  projectId: string;

  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({
    description:
      'Date the work was performed (YYYY-MM-DD). Only one report per employee per project per day is allowed.',
  })
  @IsDateString()
  reportDate: string;

  @ApiProperty({ minimum: 0.1, maximum: 24 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(24)
  hours: number;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  @Transform(({ value }) => trim(value))
  content: string;
}
