import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CompleteMaintenanceDto {
  @ApiProperty()
  @IsBoolean()
  networkRegistered!: boolean;

  @ApiProperty()
  @IsBoolean()
  toppedUp!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  topUpAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class SkipMaintenanceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
