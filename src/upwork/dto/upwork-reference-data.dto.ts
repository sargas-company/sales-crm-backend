import { PartialType } from '@nestjs/mapped-types';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UpworkReferenceCategory } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateUpworkReferenceDataDto {
  @ApiPropertyOptional({ description: 'null = shared across all profiles' })
  @IsOptional()
  @IsUUID()
  profileId?: string;

  @ApiProperty({ enum: UpworkReferenceCategory })
  @IsEnum(UpworkReferenceCategory)
  category!: UpworkReferenceCategory;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  value!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  frequency?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiProperty({ example: '2026-10-29' })
  @IsDateString()
  collectedDate!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateUpworkReferenceDataDto extends PartialType(
  CreateUpworkReferenceDataDto,
) {}

/* Bulk-add — one shared category/profile/date, N values. */
export class BulkAddUpworkReferenceDataDto {
  @ApiPropertyOptional({ description: 'null = shared across all profiles' })
  @IsOptional()
  @IsUUID()
  profileId?: string;

  @ApiProperty({ enum: UpworkReferenceCategory })
  @IsEnum(UpworkReferenceCategory)
  category!: UpworkReferenceCategory;

  @ApiProperty({ example: '2026-10-29' })
  @IsDateString()
  collectedDate!: string;

  @ApiProperty({ type: [String], example: ['react', 'typescript'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  values!: string[];
}

export class ListUpworkReferenceDataDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  profileId?: string;

  @ApiPropertyOptional({ enum: UpworkReferenceCategory })
  @IsOptional()
  @IsEnum(UpworkReferenceCategory)
  category?: UpworkReferenceCategory;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description: 'sort by frequency desc when true',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  sortByFrequency?: boolean;
}

export class BulkDeleteUpworkReferenceDataDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids!: string[];
}
