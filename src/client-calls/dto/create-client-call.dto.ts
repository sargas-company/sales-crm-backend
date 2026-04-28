import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClientCallClientType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateClientCallDto {
  @ApiProperty({ enum: ClientCallClientType })
  @IsEnum(ClientCallClientType)
  clientType: ClientCallClientType;

  @ApiPropertyOptional({ example: 'uuid-of-lead' })
  @ValidateIf((o) => o.clientType === ClientCallClientType.lead)
  @IsString()
  leadId?: string;

  @ApiPropertyOptional({ example: 'uuid-of-client-request' })
  @ValidateIf((o) => o.clientType === ClientCallClientType.client_request)
  @IsString()
  clientRequestId?: string;

  @ApiProperty({ example: 'Discovery Call' })
  @IsString()
  @MinLength(1)
  callTitle: string;

  @ApiPropertyOptional({ example: 'https://meet.google.com/abc-xyz' })
  @IsOptional()
  @IsUrl()
  meetingUrl?: string;

  @ApiProperty({ example: '2026-04-30T15:00:00.000Z' })
  @IsDateString()
  scheduledAt: string;

  @ApiProperty({ example: 'America/New_York' })
  @IsString()
  @MinLength(1)
  clientTimezone: string;

  @ApiProperty({ example: 60 })
  @IsInt()
  @IsPositive()
  duration: number;
}
