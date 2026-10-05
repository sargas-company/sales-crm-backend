import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ListEntriesQueryDto {
  @ApiProperty({
    required: false,
    description: 'Start of the date range (ISO date). Filters by fiscal week start.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiProperty({
    required: false,
    description: 'End of the date range (ISO date). Filters by fiscal week end.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiProperty({ required: false, enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiProperty({ required: false, description: 'Text search across project, client, note' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 50, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number = 50;
}
