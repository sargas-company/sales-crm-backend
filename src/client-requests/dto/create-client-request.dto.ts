import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateClientRequestDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsOptional()
  @IsString()
  company?: string;

  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

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
    example: '["Web Development","MVP Development"]',
    description: 'JSON string array of requested services',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })
  @IsArray()
  @IsString({ each: true })
  services?: string[];
}
