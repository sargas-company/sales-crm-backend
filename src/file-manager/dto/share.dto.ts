import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export enum ShareResourceType {
  FOLDER = 'FOLDER',
  FILE = 'FILE',
}

/** Blueprint for a single share — reused by invite-create and
 *  direct-share-create. Mirrors the Prisma model fields. */
export class ShareBlueprintDto {
  @ApiProperty({ enum: ShareResourceType })
  @IsEnum(ShareResourceType)
  resourceType!: ShareResourceType;

  @ApiProperty()
  @IsUUID()
  resourceId!: string;

  @ApiProperty({ default: false })
  @IsBoolean()
  recursive!: boolean;

  @ApiProperty({ default: true })
  @IsBoolean()
  canDownload!: boolean;

  @ApiProperty({ default: false })
  @IsBoolean()
  canUpload!: boolean;

  @ApiProperty({ default: false })
  @IsBoolean()
  canCreateSubfolders!: boolean;
}

export class CreateDirectShareDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ type: () => ShareBlueprintDto })
  @ValidateNested()
  @Type(() => ShareBlueprintDto)
  share!: ShareBlueprintDto;
}

export class UpdateShareDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  recursive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  canDownload?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  canUpload?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  canCreateSubfolders?: boolean;
}

export class CreateInviteDto {
  @ApiProperty({ type: [ShareBlueprintDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShareBlueprintDto)
  shares!: ShareBlueprintDto[];

  /** Days until expiry. 0 = never. Default 7. */
  @ApiPropertyOptional({ default: 7 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  expiresInDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
