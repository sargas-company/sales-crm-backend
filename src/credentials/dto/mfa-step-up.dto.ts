import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

/**
 * Fresh MFA proof required for Owner-only hard delete, independently of
 * the active vault session. Validated as part of the hard-delete bodies
 * so the global `ValidationPipe` (whitelist + forbidNonWhitelisted) does
 * not strip the field.
 */
export class MfaStepUpDto {
  @ApiProperty({ enum: ['passkey', 'totp'] })
  @IsEnum(['passkey', 'totp'])
  method!: 'passkey' | 'totp';

  @ApiPropertyOptional({ description: 'Six-digit TOTP code when method = totp.' })
  @IsOptional()
  @IsString()
  @Length(4, 12)
  code?: string;

  @ApiPropertyOptional({
    description:
      'WebAuthn authentication response JSON when method = passkey. Shape is validated downstream by @simplewebauthn/server.',
  })
  @IsOptional()
  @IsObject()
  assertion?: Record<string, unknown>;
}
