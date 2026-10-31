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

  @ApiProperty({ description: 'Free-text note — what did you change?' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
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
