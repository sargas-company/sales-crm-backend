import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreatePositionDto {
  @ApiProperty({ example: 'Backend engineer' })
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({ example: 'backend-engineer' })
  @IsString()
  @MinLength(1)
  slug: string;
}
