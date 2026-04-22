import { ApiProperty } from '@nestjs/swagger';
import { ProposalType } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class ConvertToProposalDto {
  @ApiProperty({ enum: ProposalType, example: ProposalType.Bid })
  @IsEnum(ProposalType)
  proposalType: ProposalType;

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
}
