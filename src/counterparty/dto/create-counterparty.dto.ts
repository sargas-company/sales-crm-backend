import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

import { CounterpartyType } from '@prisma/client';

export class CreateCounterpartyDto {
  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  lastName: string;

  @ApiProperty({ enum: CounterpartyType, example: CounterpartyType.client })
  @IsEnum(CounterpartyType)
  type: CounterpartyType;

  @ApiPropertyOptional({ example: 'Freelance developer, based in Kyiv' })
  @IsOptional()
  @IsString()
  info?: string;
}
