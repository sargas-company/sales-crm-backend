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

import { ProposalStatus, ProposalType } from '@prisma/client';

export class UpdateProposalDto {
  @ApiProperty({ example: 'Full Stack Developer — MVP Project', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @ApiProperty({ example: 'uuid-of-account', required: false })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiProperty({ example: 'uuid-of-platform', required: false })
  @IsOptional()
  @IsString()
  platformId?: string;

  @ApiProperty({ enum: ProposalType, example: ProposalType.Bid, required: false })
  @IsOptional()
  @IsEnum(ProposalType)
  proposalType?: ProposalType;

  @ApiProperty({ enum: ProposalStatus, example: ProposalStatus.Sent, required: false })
  @IsOptional()
  @IsEnum(ProposalStatus)
  status?: ProposalStatus;

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

  @ApiProperty({ example: 'We are looking for a React developer...', required: false })
  @IsOptional()
  @IsString()
  vacancy?: string;
}
