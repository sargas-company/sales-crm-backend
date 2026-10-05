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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { MfaService } from '../credentials-vault/mfa.service';
import { VaultSessionGuard } from '../credentials-vault/vault-session.guard';
import { CredentialsAccountService } from './credentials-account.service';
import { CredentialsAttachmentService } from './credentials-attachment.service';
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
    private readonly attachments: CredentialsAttachmentService,
    private readonly mfa: MfaService,
  ) {}

  @Get()
  @RequirePermission('credentials:view')
  @ApiOperation({ summary: 'List accounts (safe metadata only)' })
  list(@Query() query: ListCredentialAccountsDto) {
    return this.accounts.list(query);
  }

  @Get(':id')
  @RequirePermission('credentials:view')
  @ApiOperation({ summary: 'Get one account (safe metadata only)' })
  getOne(@Param('id') id: string) {
    return this.accounts.getOne(id);
  }

  @Post()
  @RequirePermission('credentials:create')
  @ApiOperation({ summary: 'Create account with encrypted payload' })
  create(
    @Body() dto: CreateCredentialAccountDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.create(dto, req.user, requestContext(req));
  }

  @Patch(':id')
  @RequirePermission('credentials:update')
  @ApiOperation({ summary: 'Update account (partial secret merge)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCredentialAccountDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.update(id, dto, req.user, requestContext(req));
  }

  @Post(':id/archive')
  @RequirePermission('credentials:archive')
  @ApiOperation({ summary: 'Archive an account' })
  archive(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.archive(id, req.user, requestContext(req));
  }

  @Post(':id/restore')
  @RequirePermission('credentials:archive')
  @ApiOperation({ summary: 'Restore an archived account' })
  restore(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.accounts.restore(id, req.user, requestContext(req));
  }

  @Delete(':id')
  @RequirePermission('credentials:hard_delete')
  @UseGuards(VaultSessionGuard)
  @ApiOperation({
    summary:
      'Hard delete (Owner). Requires an active vault session AND a fresh MFA step-up (`mfa.code`/`mfa.assertion` in body).',
  })
  async hardDelete(
    @Param('id') id: string,
    @Body() dto: HardDeleteAccountDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    await this.requireFreshMfa(req.user.id, dto.mfa);
    return this.accounts.hardDelete(id, dto, req.user, requestContext(req));
  }

  /**
   * Hard-delete step-up: even with an active vault session, hard delete
   * on Account requires a fresh MFA proof — a live TOTP or WebAuthn
   * assertion supplied in the request body.
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
  @ApiOperation({
    summary: 'Best-effort audit hook. Frontend sends a field name; no value.',
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

  // ─── Attachments ──────────────────────────────────────────────────

  @Get(':id/attachments')
  @RequirePermission('credentials:view')
  @ApiOperation({ summary: 'List attachments for account (metadata only)' })
  listAttachments(@Param('id') id: string) {
    return this.attachments.listForAccount(id);
  }

  @Post(':id/attachments')
  @RequirePermission('credentials:attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiOperation({
    summary: 'Upload an attachment. Encrypted before persist. Executables refused.',
  })
  uploadAttachment(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: AuthUser },
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.attachments.upload(
      id,
      {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      },
      req.user,
      requestContext(req),
    );
  }

  @Get('attachments/:attachmentId/download')
  @RequirePermission('credentials:attachments')
  @UseGuards(VaultSessionGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary:
      'Decrypt + stream one attachment. Requires active vault session. Rate-limited; audit-logged.',
  })
  async downloadAttachment(
    @Param('attachmentId') attachmentId: string,
    @Req() req: Request & { user: AuthUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.attachments.download(
      attachmentId,
      req.user,
      requestContext(req),
    );
    res.setHeader('Content-Type', result.mime);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.filename)}"`,
    );
    res.setHeader('Content-Length', String(result.size));
    return result.content;
  }

  @Delete('attachments/:attachmentId')
  @RequirePermission('credentials:attachments')
  @ApiOperation({ summary: 'Delete an attachment' })
  deleteAttachment(
    @Param('attachmentId') attachmentId: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.attachments.delete(attachmentId, req.user, requestContext(req));
  }
}
