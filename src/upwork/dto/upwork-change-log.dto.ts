import { PartialType } from '@nestjs/mapped-types';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UpworkChangeLogSection } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
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

  @ApiProperty()
  @IsString()
  before!: string;

  @ApiProperty()
  @IsString()
  after!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  referenceIds?: string[];
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
