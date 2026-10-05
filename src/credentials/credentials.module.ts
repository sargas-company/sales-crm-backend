import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { CredentialsAccountController } from './credentials-account.controller';
import { CredentialsAccountService } from './credentials-account.service';
import { CredentialsAttachmentService } from './credentials-attachment.service';
import { CredentialsPolicyController } from './credentials-policy.controller';
import { CredentialsProfileController } from './credentials-profile.controller';
import { CredentialsProfileService } from './credentials-profile.service';

/**
 * Credentials backend module. Depends on the globally-registered
 * `CredentialsVaultModule` (encryption + rate limiter) and
 * `AuditEventModule` (append-only audit stream). Settings-driven
 * policy values (vault session TTL, reveal auto-hide, attachment
 * size cap) are read via `SettingsService`.
 */
@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [
    CredentialsProfileController,
    CredentialsAccountController,
    CredentialsPolicyController,
  ],
  providers: [
    CredentialsProfileService,
    CredentialsAccountService,
    CredentialsAttachmentService,
  ],
  exports: [CredentialsProfileService, CredentialsAccountService],
})
export class CredentialsModule {}
