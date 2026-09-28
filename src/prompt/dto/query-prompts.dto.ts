import { ApiPropertyOptional } from '@nestjs/swagger';
import { PromptType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export enum PromptSortBy {
  title = 'title',
  type = 'type',
  version = 'version',
  isActive = 'isActive',
  createdBy = 'createdBy',
  updatedAt = 'updatedAt',
  createdAt = 'createdAt',
}

export enum PromptSortDirection {
  asc = 'asc',
  desc = 'desc',
}

export class QueryPromptsDto {
  @ApiPropertyOptional({ enum: PromptType })
  @IsOptional()
  @IsEnum(PromptType)
  type?: PromptType;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ enum: PromptSortBy })
  @IsOptional()
  @IsEnum(PromptSortBy)
  sortBy?: PromptSortBy;

  @ApiPropertyOptional({
    enum: PromptSortDirection,
    default: PromptSortDirection.desc,
  })
  @IsOptional()
  @IsEnum(PromptSortDirection)
  sortDirection?: PromptSortDirection;

  @ApiPropertyOptional({
    description: 'Partial, case-insensitive match against title.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  search?: string;
}
