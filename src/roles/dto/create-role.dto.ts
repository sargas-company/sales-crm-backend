import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({
    example: 'sales_lead',
    description: 'Slug — lowercase letters, digits, underscore. Immutable after create.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'name must match /^[a-z][a-z0-9_]*$/ (lowercase slug)',
  })
  name!: string;

  @ApiProperty({ example: 'Sales Lead' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  label!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiProperty({
    type: [String],
    example: ['proposals:view', 'leads:view'],
    description: 'Capability keys to grant to the new role.',
  })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionKeys!: string[];
}
