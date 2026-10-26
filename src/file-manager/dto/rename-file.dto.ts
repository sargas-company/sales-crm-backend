import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RenameFileDto {
  @ApiProperty({ example: 'brief-v3.pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;
}
