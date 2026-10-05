import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { MfaService } from '../credentials-vault/mfa.service';
import { VaultSessionGuard } from '../credentials-vault/vault-session.guard';
import { CredentialsProfileService, RequestContext } from './credentials-profile.service';
import { CreateCredentialProfileDto } from './dto/create-profile.dto';
import {
  HardDeleteProfileDto,
  ListCredentialProfilesDto,
} from './dto/list-profiles.dto';
import { UpdateCredentialProfileDto } from './dto/update-profile.dto';

function requestContext(req: Request): RequestContext {
  return {
    ip: (req.ip || req.headers['x-forwarded-for'] || '').toString().split(',')[0] || null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
  };
}

@ApiTags('Credential Profiles')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('credential-profiles')
export class CredentialsProfileController {
  constructor(
    private readonly service: CredentialsProfileService,
    private readonly mfa: MfaService,
  ) {}

  @Get()
  @RequirePermission('credentials:view')
  @ApiOperation({ summary: 'List credential profiles (safe metadata only)' })
  list(@Query() query: ListCredentialProfilesDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermission('credentials:view')
  @ApiOperation({ summary: 'Get one profile (safe metadata only)' })
  getOne(@Param('id') id: string) {
    return this.service.getOne(id);
  }

  @Post()
  @RequirePermission('credentials:create')
  @ApiOperation({ summary: 'Create a profile' })
  create(
    @Body() dto: CreateCredentialProfileDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.service.create(dto, req.user, requestContext(req));
  }

  @Patch(':id')
  @RequirePermission('credentials:update')
  @ApiOperation({ summary: 'Update a profile' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCredentialProfileDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.service.update(id, dto, req.user, requestContext(req));
  }

  @Post(':id/archive')
  @RequirePermission('credentials:archive')
  @ApiOperation({ summary: 'Archive a profile' })
  archive(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.service.archive(id, req.user, requestContext(req));
  }

  @Post(':id/restore')
  @RequirePermission('credentials:archive')
  @ApiOperation({ summary: 'Restore an archived profile' })
  restore(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.service.restore(id, req.user, requestContext(req));
  }

  @Delete(':id')
  @RequirePermission('credentials:hard_delete')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({
    summary:
      'Hard delete (Owner). Requires an active vault session, typed profile-name confirmation AND a fresh MFA step-up (`mfa.code` / `mfa.assertion`).',
  })
  async hardDelete(
    @Param('id') id: string,
    @Body() dto: HardDeleteProfileDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    await this.requireFreshMfa(req.user.id, dto.mfa);
    return this.service.hardDelete(id, dto, req.user, requestContext(req));
  }

  /**
   * Hard delete on either a Profile or an Account requires a fresh MFA
   * proof — the active vault session alone is not sufficient. Either a
   * live TOTP or a live WebAuthn assertion is accepted.
   */
  private async requireFreshMfa(
    userId: string,
    mfa?: {
      method: 'passkey' | 'totp';
      code?: string;
      assertion?: Record<string, unknown>;
    },
  ) {
    if (!mfa) throw new ForbiddenException('Fresh MFA required to hard delete.');
    let ok = false;
    if (mfa.method === 'passkey' && mfa.assertion) {
      ok = await this.mfa.completePasskeyAssertion(
        userId,
        mfa.assertion as unknown as import('@simplewebauthn/server').AuthenticationResponseJSON,
      );
    } else if (mfa.method === 'totp' && mfa.code) {
      ok = await this.mfa.verifyTotp(userId, mfa.code);
    }
    if (!ok) throw new ForbiddenException('MFA step-up failed.');
  }
}
