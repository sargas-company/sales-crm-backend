import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { LinkedInAccountType } from '@prisma/client';

export enum LinkedInAccountSortBy {
  displayName = 'displayName',
  type = 'type',
  isActive = 'isActive',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
}

export enum SortDir {
  asc = 'asc',
  desc = 'desc',
}

export class ListLinkedInAccountsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(({ value }) => (value == null ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => (value == null ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: LinkedInAccountType })
  @IsOptional()
  @IsEnum(LinkedInAccountType)
  type?: LinkedInAccountType;

  @ApiPropertyOptional({ description: 'active | inactive | all' })
  @IsOptional()
  @IsString()
  status?: 'active' | 'inactive' | 'all';

  @ApiPropertyOptional({ enum: LinkedInAccountSortBy, default: LinkedInAccountSortBy.displayName })
  @IsOptional()
  @IsEnum(LinkedInAccountSortBy)
  sortBy?: LinkedInAccountSortBy = LinkedInAccountSortBy.displayName;

  @ApiPropertyOptional({ enum: SortDir, default: SortDir.asc })
  @IsOptional()
  @IsEnum(SortDir)
  sortDir?: SortDir = SortDir.asc;
}
