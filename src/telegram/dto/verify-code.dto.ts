import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class VerifyCodeDto {
  @ApiProperty({ example: '12345' })
  @IsString()
  @Length(5, 6)
  code: string;
}
