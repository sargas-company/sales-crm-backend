import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateProposalDto {
  @ApiProperty({ example: 'Full Stack Developer — MVP Project' })
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({ example: 'We are looking for a React developer...', required: false })
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
