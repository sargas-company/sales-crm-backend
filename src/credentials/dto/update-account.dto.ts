import { ApiProperty, ApiPropertyOptional, PartialType, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { CreateCredentialAccountDto } from './create-account.dto';
import { SecretPayloadDto } from './secret-payload.dto';
import { MfaStepUpDto } from './mfa-step-up.dto';

/**
 * Update payload. Every field is optional; only supplied fields are
 * touched. Secrets replace the whole payload if provided (a caller who
 * only wants to change the password can PATCH `{ secrets: { password } }`
 * — the service merges into the existing decrypted payload).
 */
export class UpdateCredentialAccountDto extends PartialType(
  PickType(CreateCredentialAccountDto, [
    'serviceName',
    'category',
    'serviceUrl',
    'iconUrl',
    'tags',
    'usernameHint',
    'lastRotatedAt',
    'rotationReminderAt',
  ] as const),
) {
  @ApiPropertyOptional({ type: SecretPayloadDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SecretPayloadDto)
  secrets?: SecretPayloadDto;
}

export class HardDeleteAccountDto {
  @ApiProperty({
    description:
      'Must exactly equal the current serviceName to confirm a Owner-only hard delete.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  confirmation!: string;

  @ApiProperty({ type: MfaStepUpDto })
  @ValidateNested()
  @Type(() => MfaStepUpDto)
  mfa!: MfaStepUpDto;
}
