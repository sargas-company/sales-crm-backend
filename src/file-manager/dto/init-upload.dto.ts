import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class InitUploadDto {
  @ApiProperty({ example: 'quarterly-report-Q4-2026.pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  mimeType!: string;

  @ApiProperty({ example: 10_485_760, description: 'File size in bytes.' })
  @IsInt()
  @Min(1)
  size!: number;

  @ApiProperty({
    example: '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
    description: 'Lowercase SHA-1 hex of the full file.',
  })
  @IsString()
  @Matches(/^[0-9a-f]{40}$/, { message: 'sha1 must be 40 hex chars (lowercase)' })
  sha1!: string;

  @ApiPropertyOptional({ description: 'Target folder id. Omit for root.' })
  @IsOptional()
  @IsUUID()
  folderId?: string;
}
