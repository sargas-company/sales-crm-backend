import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PhoneStatus } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreatePhoneBindingDto {
  @ApiProperty({ description: 'Owning PhoneNumber id.' })
  @IsUUID()
  phoneNumberId!: string;

  @ApiProperty({ description: 'PhoneService (catalogue) id.' })
  @IsUUID()
  serviceId!: string;

  @ApiPropertyOptional({ description: 'Linked CredentialProfile id.', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  credentialProfileId?: string | null;

  @ApiPropertyOptional({ enum: PhoneStatus })
  @IsOptional()
  @IsEnum(PhoneStatus)
  status?: PhoneStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
