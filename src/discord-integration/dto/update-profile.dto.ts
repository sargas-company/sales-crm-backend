import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

const SNOWFLAKE = /^[0-9]{17,20}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateDiscordProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(SNOWFLAKE) guildId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(SNOWFLAKE) pmsChannelId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(SNOWFLAKE) generalChannelId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(SNOWFLAKE) salesChannelId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(SNOWFLAKE) opsChannelId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(SNOWFLAKE) managerRoleId?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() reportsEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() birthdaysEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() absencesEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() weeklyEnabled?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(23) cutoffHour?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(HHMM) reminderAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(HHMM) dailyDigestAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(6) weeklyDigestDay?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(HHMM) weeklyDigestAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(HHMM) birthdayAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(HHMM) absencesAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() timezone?: string;
}
