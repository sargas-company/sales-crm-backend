import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreatePlatformDto {
  @ApiProperty({ example: 'Upwork' })
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({ example: 'upwork' })
  @IsString()
  @MinLength(1)
  slug: string;

  @ApiProperty({ example: 'https://example.com/upwork.png', required: false })
  @IsOptional()
  @IsString()
  imageUrl?: string;
}
