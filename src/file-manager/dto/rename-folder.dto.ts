import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RenameFolderDto {
  @ApiProperty({ example: 'Design assets v2' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}
