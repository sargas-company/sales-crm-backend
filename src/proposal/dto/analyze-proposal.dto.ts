import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class AnalyzeProposalDto {
  @ApiProperty({ example: 'We need a React developer for a 3-month project' })
  @IsString()
  @MinLength(1)
  content: string;
}
