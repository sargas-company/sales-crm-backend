import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Length,
  ValidateNested,
} from 'class-validator';
import { SecretPayloadDto } from './secret-payload.dto';

export class CreateCredentialAccountDto {
  @ApiProperty({ description: 'Owning CredentialProfile id' })
  @IsUUID()
  profileId!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  serviceName!: string;

  @ApiProperty({ minLength: 1, maxLength: 60 })
  @IsString()
  @Length(1, 60)
  category!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  serviceUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  iconUrl?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Displayed masked hint, e.g. va***@gmail.com' })
  @IsOptional()
  @IsString()
  @Length(0, 120)
  usernameHint?: string;

  @ApiProperty({ type: SecretPayloadDto })
  @ValidateNested()
  @Type(() => SecretPayloadDto)
  secrets!: SecretPayloadDto;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp of the last rotation.' })
  @IsOptional()
  @IsDateString()
  lastRotatedAt?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp for next reminder.' })
  @IsOptional()
  @IsDateString()
  rotationReminderAt?: string;
}
