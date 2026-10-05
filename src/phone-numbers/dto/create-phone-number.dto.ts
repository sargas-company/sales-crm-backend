import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PhoneOperator, PhoneStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const nullOrTrimmedString = ({ value }: { value: unknown }) => {
  if (value === null) return null;
  if (typeof value === 'string') return value.trim();
  return value;
};

/**
 * Create payload for POST /phone-numbers.
 *
 * The service further normalises `number` through `normalizePhone()`
 * which prefixes a `+` and enforces E.164-ish length. We validate the
 * raw input shape here so callers get a 400 instead of the service's
 * generic `Error` turning into a 500.
 */
export class CreatePhoneNumberDto {
  @ApiProperty({ description: 'Raw phone number — any format with +/digits/separators.' })
  @IsString()
  @Length(3, 32)
  number!: string;

  @ApiPropertyOptional({ enum: PhoneOperator })
  @IsOptional()
  @IsEnum(PhoneOperator)
  operator?: PhoneOperator;

  @ApiPropertyOptional({ enum: PhoneStatus })
  @IsOptional()
  @IsEnum(PhoneStatus)
  status?: PhoneStatus;

  @ApiPropertyOptional({ description: 'Linked Employee id.', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  holderEmployeeId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(nullOrTrimmedString)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  holderName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  maintenanceRequired?: boolean;

  @ApiPropertyOptional({ description: 'ISO-8601 datetime.', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  nextMaintenanceAt?: string | null;

  @ApiPropertyOptional({ description: 'ISO-8601 datetime.', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  lastTopUpAt?: string | null;

  @ApiPropertyOptional({ description: 'ISO-8601 datetime.', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  lastNetworkRegistrationAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
