import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateAccountDto {
  @ApiProperty({ example: 'Dmytro' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  firstName: string;

  @ApiProperty({ example: 'Sarafaniuk' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  lastName: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  @IsUUID()
  platformId: string;
}
