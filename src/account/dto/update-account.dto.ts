import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateAccountDto {
  @ApiProperty({ example: 'Dmytro', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @ApiProperty({ example: 'Sarafaniuk', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001', required: false })
  @IsOptional()
  @IsString()
  platformId?: string;
}
