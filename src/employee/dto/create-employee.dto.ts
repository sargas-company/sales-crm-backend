import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = (v: unknown) =>
  typeof v === 'string' ? v.trim() || undefined : v;

const trimStrings = (v: unknown) => {
  if (!Array.isArray(v)) return v;
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : x))
    .filter((x) => typeof x === 'string' && x.length > 0);
};

export class CreateEmployeeDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }) => trim(value))
  firstName: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }) => trim(value))
  lastName: string;

  @ApiProperty()
  @IsEmail()
  @MaxLength(160)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(({ value }) => trim(value))
  phone?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Type(() => String)
  @Transform(({ value }) => trimStrings(value))
  positions?: string[];

  @ApiPropertyOptional({ enum: EmployeeStatus, default: EmployeeStatus.active })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  hiredAt?: string;

  @ApiPropertyOptional({ description: 'Optional link to an existing User' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    description:
      'Date of birth (YYYY-MM-DD). Only month/day are used by the birthday notifier; year is kept for display.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  dateOfBirth?: string | null;
}
