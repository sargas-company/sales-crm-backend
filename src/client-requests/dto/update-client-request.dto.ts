import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

import { ClientRequestStatus } from '@prisma/client';

export class UpdateClientRequestDto {
  @ApiPropertyOptional({ example: 'John Doe' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsOptional()
  @IsString()
  company?: string;

  @ApiPropertyOptional({ example: 'john@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '5551234567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'us' })
  @IsOptional()
  @IsString()
  phoneCountry?: string;

  @ApiPropertyOptional({ example: 'Need MVP development' })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({
    example: ['Web Development', 'MVP Development'],
    type: [String],
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  })
  @IsArray()
  @IsString({ each: true })
  services?: string[];

  @ApiPropertyOptional({ enum: ClientRequestStatus, example: ClientRequestStatus.conversation_ongoing })
  @IsOptional()
  @IsEnum(ClientRequestStatus)
  status?: ClientRequestStatus;
}
