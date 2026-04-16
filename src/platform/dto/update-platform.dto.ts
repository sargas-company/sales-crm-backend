import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdatePlatformDto {
  @ApiProperty({ example: 'Upwork', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @ApiProperty({ example: 'upwork', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  slug?: string;

  @ApiProperty({ example: 'https://example.com/upwork.png', required: false })
  @IsOptional()
  @IsString()
  imageUrl?: string;
}
