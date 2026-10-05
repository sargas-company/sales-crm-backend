import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

/**
 * Shape mirrors the frontend `attachments?: Array<{ url: string; name?: string; type?: string }>`
 * declared in `sales-crm-frontend/src/store/linkedin-posts/linkedInPostsApi.ts`.
 * The wire contract is unchanged — this DTO only tightens validation.
 */
export class LinkedInPostAttachmentDto {
  @ApiProperty()
  @IsString()
  @IsUrl({ require_tld: false })
  @MaxLength(2000)
  url!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 240)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 120)
  type?: string;
}
