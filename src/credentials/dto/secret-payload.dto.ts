import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

/**
 * Runtime-typed shape of the DECRYPTED payload stored in
 * `CredentialAccount.encPayload`. Never returned in list/profile responses;
 * only in the `POST /credential-accounts/:id/reveal` result (Phase 3 gates
 * this endpoint behind an active vault session).
 *
 * The class-validator decorators run on inbound Create/Update flows so a
 * client cannot slip a non-string value or a giant blob into the payload.
 */
export class SecretCustomField {
  @ApiProperty({ maxLength: 64 })
  @IsString()
  @Length(1, 64)
  label!: string;

  @ApiProperty({ maxLength: 8_000 })
  @IsString()
  @Length(0, 8_000)
  value!: string;
}

export class SecretPayloadDto {
  @ApiPropertyOptional({ maxLength: 320 })
  @IsOptional()
  @IsString()
  @Length(0, 320)
  username?: string;

  @ApiPropertyOptional({ maxLength: 320 })
  @IsOptional()
  @IsString()
  @Length(0, 320)
  email?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @Length(0, 512)
  password?: string;

  /** Base32 TOTP seed. Validated but not further parsed here. */
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @Length(0, 128)
  totpSeed?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  recoveryCodes?: string[];

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  pin?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  securityAnswers?: string[];

  @ApiPropertyOptional({ maxLength: 32_000 })
  @IsOptional()
  @IsString()
  @Length(0, 32_000)
  secureNote?: string;

  @ApiPropertyOptional({ isArray: true, type: SecretCustomField })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => SecretCustomField)
  customFields?: SecretCustomField[];
}
