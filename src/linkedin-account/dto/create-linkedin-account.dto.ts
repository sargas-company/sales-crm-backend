import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { LinkedInAccountType } from '@prisma/client';

export class CreateLinkedInAccountDto {
  @ApiProperty({ example: 'Sargas Consulting' })
  @IsString()
  @MaxLength(120)
  displayName: string;

  @ApiProperty({ enum: LinkedInAccountType })
  @IsEnum(LinkedInAccountType)
  type: LinkedInAccountType;

  @ApiProperty({ example: 'https://www.linkedin.com/company/sargas' })
  @IsUrl({ require_tld: true })
  @MaxLength(500)
  profileUrl: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(1000)
  avatarUrl?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
