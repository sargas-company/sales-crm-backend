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

import { Platform, ProposalType } from '@prisma/client';

export class CreateProposalDto {
  @ApiProperty({ example: 'Full Stack Developer — MVP Project' })
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  manager: string;

  @ApiProperty({ example: 'MyCompany' })
  @IsString()
  account: string;

  @ApiProperty({ enum: ProposalType, example: ProposalType.Bid })
  @IsEnum(ProposalType)
  proposalType: ProposalType;

  @ApiProperty({ enum: Platform, example: Platform.Upwork, required: false })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

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

  @ApiProperty({ example: 'Client prefers remote work', required: false })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiProperty({ example: 'Budget: $5000, Rating: 4.8', required: false })
  @IsOptional()
  @IsString()
  context?: string;
}
