import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TimeOffType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

const trim = (v: unknown) =>
  typeof v === 'string' ? v.trim() || undefined : v;

/**
 * Attachment fields were removed in the file-layer stabilisation —
 * the surface had no upload/download endpoints to back them, and the
 * client-controlled `attachmentKey` could have pointed anywhere.
 * Prisma columns stay nullable; destructive migration is out of
 * scope for this pass.
 */
export class CreateTimeOffDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ enum: TimeOffType })
  @IsEnum(TimeOffType)
  type: TimeOffType;

  @ApiProperty({ description: 'YYYY-MM-DD, inclusive.' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'YYYY-MM-DD, inclusive.' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }) => trim(value))
  note?: string;
}
