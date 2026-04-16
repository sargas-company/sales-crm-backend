import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateAccountDto {
  @ApiProperty({ example: 'Dmytro' })
  @IsString()
  @MinLength(1)
  firstName: string;

  @ApiProperty({ example: 'Sarafaniuk' })
  @IsString()
  @MinLength(1)
  lastName: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  @IsString()
  platformId: string;
}
