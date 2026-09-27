import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateRoleDto {
  // `name` is accepted on the DTO only so the service can return the
  // dedicated `SYSTEM_ROLE_SLUG_LOCKED` error code from spec §6 when a
  // client attempts to rename a role. Without this field the global
  // `ValidationPipe` (whitelist + forbidNonWhitelisted) would return
  // the generic "property name should not exist" instead.
  @ApiProperty({
    required: false,
    description: 'Ignored. Slug is immutable — see SYSTEM_ROLE_SLUG_LOCKED (spec §6).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  label?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiProperty({
    type: [String],
    required: false,
    description:
      "New permission set. Ignored for the 'owner' role — see " +
      'OWNER_PERMISSIONS_LOCKED (spec §6).',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionKeys?: string[];
}
