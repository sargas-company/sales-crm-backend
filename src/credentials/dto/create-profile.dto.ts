import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CredentialProfileType } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Length,
} from 'class-validator';

export class CreateCredentialProfileDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({ enum: CredentialProfileType })
  @IsEnum(CredentialProfileType)
  type!: CredentialProfileType;

  @ApiPropertyOptional({
    description: 'Optional link to an existing Employee record.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @Length(0, 4000)
  description?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  avatarUrl?: string;
}
