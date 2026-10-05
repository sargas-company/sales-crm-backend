import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class UpsertWeeklyEntryDto {
  @ApiProperty()
  @IsUUID()
  fiscalWeekId!: string;

  @ApiProperty()
  @IsUUID()
  projectId!: string;

  @ApiProperty({ enum: PaymentStatus })
  @IsEnum(PaymentStatus)
  status!: PaymentStatus;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @Matches(/^-?\d+(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string with up to 2 fractional digits',
  })
  amount?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  note?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'When the invoice was issued (ISO date, e.g. 2026-09-30). Auto-set to today on first transition to planned_invoice when omitted.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  invoiceSentAt?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'When funds actually landed (ISO date). Auto-set to today on first transition to received when omitted.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  receivedAt?: string | null;
}
