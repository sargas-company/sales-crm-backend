import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdatePaymentSourceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  /**
   * Nullable: pass `null` explicitly to clear a previously-set
   * description. Passing an empty string also clears. Omitting the
   * field leaves it untouched.
   */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdatePaymentSourceDto) => o.description !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
