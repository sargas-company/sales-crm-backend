import { PartialType } from '@nestjs/mapped-types';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUpworkKeywordDto {
  @ApiProperty({
    description: 'Phrase text. Normalized server-side (lower + trim + collapse whitespace).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  text!: string;

  @ApiPropertyOptional({
    description:
      'If true, this keyword becomes the profile primary — any previous primary is cleared.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateUpworkKeywordDto extends PartialType(CreateUpworkKeywordDto) {
  @ApiPropertyOptional({
    description: 'Soft-archive flag. Archived keywords still render on past snapshots.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
