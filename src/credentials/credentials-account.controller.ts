import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
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
import { CredentialsAccountService } from './credentials-account.service';
import { RequestContext } from './credentials-profile.service';
import { CreateCredentialAccountDto } from './dto/create-account.dto';
import { ListCredentialAccountsDto } from './dto/list-accounts.dto';
import {
  HardDeleteAccountDto,
  UpdateCredentialAccountDto,
} from './dto/update-account.dto';

function requestContext(req: Request): RequestContext {
  return {
    ip: (req.ip || req.headers['x-forwarded-for'] || '').toString().split(',')[0] || null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
  };
}

@ApiTags('Credential Accounts')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('credential-accounts')
export class CredentialsAccountController {
  constructor(
    private readonly accounts: CredentialsAccountService,
    private readonly mfa: MfaService,
  ) {}

  @Get()
  @RequirePermission('credentials:view')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({ summary: 'List accounts (metadata only, requires active vault session)' })
  list(@Query() query: ListCredentialAccountsDto) {
    return this.accounts.list(query);
  }

  @Get(':id')
  @RequirePermission('credentials:view')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({ summary: 'Get one account (metadata only, requires active vault session)' })
  getOne(@Param('id') id: string) {
    return this.accounts.getOne(id);
  }

  @Post()
  @RequirePermission('credentials:create')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({ summary: 'Create account with encrypted payload (requires active vault session)' })
  create(
    @Body() dto: CreateCredentialAccountDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.create(dto, req.user, requestContext(req));
  }

  @Patch(':id')
  @RequirePermission('credentials:update')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({ summary: 'Update account (partial secret merge, requires active vault session)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCredentialAccountDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.update(id, dto, req.user, requestContext(req));
  }

  // ─── Archive / Restore / Hard delete endpoints — intentionally removed.
  //
  // Owner spec: no in-app way to archive or delete a CredentialAccount.
  // Once created, the row stays forever. If a DB-level cleanup is ever
  // needed, an operator does it manually against the database with full
  // backup discipline — never through this API. Service methods and the
  // `credentials:archive` / `credentials:hard_delete` permissions still
  // exist so the migration shape stays stable; they are unreachable
  // from here.

  /**
   * Hard-delete step-up kept here for internal reuse by future
   * admin-tooling endpoints — do NOT re-wire the public hardDelete
   * route without re-reading the owner spec in
   * work/tasks/credentials-vault-hard-gate.md.
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

  @Post(':id/reveal')
  @RequirePermission('credentials:reveal')
  @UseGuards(VaultSessionGuard)
  // Belt-and-braces no-store policy: ask every intermediary and the
  // browser to drop the plaintext body as soon as the HTTP exchange is
  // over. Combined with the frontend's component-local, non-Redux
  // transport this keeps revealed material out of all persistent and
  // shared caches.
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({
    summary:
      'Reveal the decrypted payload. Requires active vault session. Rate-limited; audit-logged.',
  })
  reveal(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.reveal(id, req.user, requestContext(req));
  }

  @Post(':id/copy')
  @RequirePermission('credentials:reveal')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({
    summary: 'Best-effort audit hook. Frontend sends a field name; no value. Requires active vault session.',
  })
  async recordCopy(
    @Param('id') id: string,
    @Body() body: { field?: string },
    @Req() req: Request & { user: AuthUser },
  ) {
    if (!body || typeof body.field !== 'string' || !body.field.trim()) {
      throw new BadRequestException('field required');
    }
    await this.accounts.recordCopy(id, body.field, req.user, requestContext(req));
    return { ok: true };
  }

  // Attachment endpoints removed together with the Credentials-attachments
  // feature. The CredentialAttachment table + storage service + the
  // `credentials:attachments` permission went away in the same release.
  // If files-per-account ever come back, re-wire via a new module —
  // don't resurrect the old service directly.

  // ─── History ──────────────────────────────────────────────────────

  @Get(':id/history')
  @RequirePermission('credentials:view')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({ summary: 'List encrypted-payload history for an account (metadata only).' })
  listHistory(@Param('id') id: string) {
    return this.accounts.listVersions(id);
  }

  @Post(':id/history/:versionId/reveal')
  @RequirePermission('credentials:reveal')
  @UseGuards(VaultSessionGuard)
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({
    summary:
      'Reveal a historic version. Active vault session is sufficient — same gate as the live reveal; no extra MFA step-up on top of the session.',
  })
  async revealVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.revealVersion(id, versionId, req.user, requestContext(req));
  }

  @Post(':id/history/:versionId/restore')
  @RequirePermission('credentials:update')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({
    summary:
      'Restore a historic version as the current payload. Snapshots the current state as a new version so the restore itself is reversible. Fires Discord notif.',
  })
  async restoreVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.restoreVersion(id, versionId, req.user, requestContext(req));
  }

  // ─── Hard delete (Owner only) ─────────────────────────────────────

  @Delete(':id')
  @RequirePermission('credentials:hard_delete')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({
    summary:
      'Hard delete (Owner). Requires active vault session, typed serviceName confirmation AND a fresh MFA step-up.',
  })
  async hardDelete(
    @Param('id') id: string,
    @Body() dto: HardDeleteAccountDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    await this.requireFreshMfa(req.user.id, dto.mfa);
    return this.accounts.hardDelete(id, dto, req.user, requestContext(req));
  }
}
