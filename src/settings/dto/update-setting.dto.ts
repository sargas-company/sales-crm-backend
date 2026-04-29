import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class UpdateSettingDto {
  @ApiProperty({ description: 'New value for the setting' })
  @IsNotEmpty()
  value: unknown;
}
