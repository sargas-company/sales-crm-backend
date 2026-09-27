import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

// Plain hex-UUID regex (accepts any version bit including the `0000`
// seeded IDs `00000000-0000-0000-0000-...`). `@IsUUID('all')` in this
// class-validator release still enforces the v4 version nibble; the
// strict regex here matches any RFC-shaped UUID.
const UUID_ANY_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AssignRoleDto {
  @ApiProperty({ description: 'Role id to assign to the user.' })
  @IsString()
  @Matches(UUID_ANY_VERSION, { message: 'roleId must be a UUID (any version)' })
  roleId!: string;
}
