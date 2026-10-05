import { ApiProperty } from '@nestjs/swagger';
import { PaymentRuleType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  IsDateString,
} from 'class-validator';

export class UpsertPaymentRuleDto {
  @ApiProperty({ enum: PaymentRuleType })
  @IsEnum(PaymentRuleType)
  type!: PaymentRuleType;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  delayDays?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: '1=Mon..7=Sun',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  intervalWeeks?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  note?: string | null;

  @ApiProperty({
    required: false,
    description: 'ISO date; defaults to today',
  })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
