import { PartialType } from '@nestjs/mapped-types';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UpworkChangeLogSection } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUpworkChangeLogDto {
  @ApiProperty({ example: '2026-10-29' })
  @IsDateString()
  date!: string;

  @ApiProperty()
  @IsUUID()
  profileId!: string;

  @ApiProperty({ enum: UpworkChangeLogSection })
  @IsEnum(UpworkChangeLogSection)
  section!: UpworkChangeLogSection;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  item?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  /* Optional. For job_analysis entries (research notes) before/after
   * can be omitted entirely; stored as empty strings when absent. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  before?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  after?: string;
}

export class UpdateUpworkChangeLogDto extends PartialType(
  CreateUpworkChangeLogDto,
) {}

export class ListUpworkChangeLogDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  profileId?: string;

  @ApiPropertyOptional({ enum: UpworkChangeLogSection })
  @IsOptional()
  @IsEnum(UpworkChangeLogSection)
  section?: UpworkChangeLogSection;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
