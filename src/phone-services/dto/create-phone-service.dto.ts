import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreatePhoneServiceDto {
  @ApiProperty({ example: 'WhatsApp' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiProperty({ example: 'whatsapp' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'slug must be lowercase letters, digits or underscores, starting with a letter',
  })
  slug: string;
}
