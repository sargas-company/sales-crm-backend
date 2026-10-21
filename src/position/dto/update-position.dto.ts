import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdatePositionDto {
  @ApiProperty({ example: 'Backend engineer', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @ApiProperty({ example: 'backend-engineer', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  slug?: string;
}
