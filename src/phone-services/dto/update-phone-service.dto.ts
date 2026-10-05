import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdatePhoneServiceDto {
  @ApiProperty({ example: 'WhatsApp', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiProperty({ example: 'whatsapp', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'slug must be lowercase letters, digits or underscores, starting with a letter',
  })
  slug?: string;
}
