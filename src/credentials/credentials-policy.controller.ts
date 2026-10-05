import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import { CredentialsAttachmentService } from './credentials-attachment.service';

/**
 * Non-secret Credentials policy snapshot — the values the UI needs
 * to drive its vault-session countdown, reveal auto-hide timer and
 * attachment pre-check. Served under `credentials:view` so Admin
 * Manager (who has Credentials access but NOT Settings) can read
 * the policy that applies to them without touching Settings API.
 *
 * No secret env values, cipher material or raw Settings rows are
 * returned here.
 */
@ApiTags('Credentials policy')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('credentials/policy')
export class CredentialsPolicyController {
  constructor(
    private readonly settings: SettingsService,
    private readonly attachments: CredentialsAttachmentService,
  ) {}

  @Get()
  @RequirePermission('credentials:view')
  @ApiOperation({
    summary:
      'Effective Credentials policy: vault session TTL, reveal auto-hide, max attachment size.',
  })
  async get() {
    const [vaultSessionMinutes, revealAutoHideSeconds, maxAttachmentBytes] =
      await Promise.all([
        this.settings.getNumberForKey(SK.CREDENTIALS_VAULT_SESSION_MIN, 60),
        this.settings.getNumberForKey(
          SK.CREDENTIALS_REVEAL_AUTOHIDE_SEC,
          30,
        ),
        this.attachments.getMaxAttachmentBytes(),
      ]);
    const clampedVault = Math.min(240, Math.max(5, vaultSessionMinutes));
    const clampedReveal = Math.min(600, Math.max(5, revealAutoHideSeconds));
    return {
      vaultSessionMinutes: clampedVault,
      revealAutoHideSeconds: clampedReveal,
      maxAttachmentMegabytes: Math.floor(maxAttachmentBytes / (1024 * 1024)),
    };
  }
}
