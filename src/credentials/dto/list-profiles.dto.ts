import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CredentialProfileStatus,
  CredentialProfileType,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MfaStepUpDto } from './mfa-step-up.dto';

export class ListCredentialProfilesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: CredentialProfileType })
  @IsOptional()
  @IsEnum(CredentialProfileType)
  type?: CredentialProfileType;

  @ApiPropertyOptional({ enum: CredentialProfileStatus })
  @IsOptional()
  @IsEnum(CredentialProfileStatus)
  status?: CredentialProfileStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class HardDeleteProfileDto {
  @ApiProperty({
    description:
      'Must exactly equal the current profile name to confirm a Owner-only hard delete.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  confirmation!: string;

  @ApiProperty({ type: MfaStepUpDto })
  @ValidateNested()
  @Type(() => MfaStepUpDto)
  mfa!: MfaStepUpDto;
}
