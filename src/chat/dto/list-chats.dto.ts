import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export enum ChatFilterType {
  proposal = 'proposal',
  lead = 'lead',
}

export class ListChatsDto {
  @ApiPropertyOptional({ example: 'proposal-uuid-here', description: 'Cursor — id последнего элемента предыдущей страницы' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ enum: ChatFilterType, description: 'proposal — чаты с proposal, lead — чаты с lead, без параметра — все' })
  @IsOptional()
  @IsEnum(ChatFilterType)
  type?: ChatFilterType;
}
