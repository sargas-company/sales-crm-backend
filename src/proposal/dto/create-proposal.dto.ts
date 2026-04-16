import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

import { ProposalType } from '@prisma/client';

export class CreateProposalDto {
  @ApiProperty({ example: 'Full Stack Developer — MVP Project' })
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({ example: 'uuid-of-account' })
  @IsString()
  accountId: string;

  @ApiProperty({ example: 'uuid-of-platform' })
  @IsString()
  platformId: string;

  @ApiProperty({ enum: ProposalType, example: ProposalType.Bid })
  @IsEnum(ProposalType)
  proposalType: ProposalType;

  @ApiProperty({ example: '~01abc1234567890def', required: false })
  @IsOptional()
  @IsString()
  jobUrl?: string;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  boosted?: boolean;

  @ApiProperty({ example: 6, required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  connects?: number;

  @ApiProperty({ example: 14, required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  boostedConnects?: number;

  @ApiProperty({ example: 'Dear client, ...', required: false })
  @IsOptional()
  @IsString()
  coverLetter?: string;

  @ApiProperty({
    example: 'We are looking for a React developer...',
    required: false,
  })
  @IsOptional()
  @IsString()
  vacancy?: string;
}
