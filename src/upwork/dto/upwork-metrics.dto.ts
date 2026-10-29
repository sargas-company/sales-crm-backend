import { PartialType } from '@nestjs/mapped-types';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class SnapshotPositionDto {
  @ApiProperty({ description: 'title_phrase reference-data id' })
  @IsUUID()
  referenceDataId!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  position!: number;
}

export class CreateUpworkSnapshotDto {
  @ApiProperty({ example: '2026-10-29' })
  @IsDateString()
  date!: string;

  @ApiProperty()
  @IsUUID()
  profileId!: string;

  @ApiProperty({ default: 0 })
  @IsInt()
  @Min(0)
  views!: number;

  @ApiProperty({ default: 0 })
  @IsInt()
  @Min(0)
  invites!: number;

  @ApiProperty({ default: 0 })
  @IsInt()
  @Min(0)
  directMessages!: number;

  @ApiPropertyOptional({ type: [SnapshotPositionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SnapshotPositionDto)
  positions?: SnapshotPositionDto[];
}

export class UpdateUpworkSnapshotDto extends PartialType(CreateUpworkSnapshotDto) {}

export class ListUpworkSnapshotsDto {
  @ApiProperty()
  @IsUUID()
  profileId!: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
