import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DiscordIntegrationModule } from '../discord-integration/discord-integration.module';
import { SettingsModule } from '../settings/settings.module';
import { CredentialChangeNotifierService } from './credential-change-notifier.service';
import { CredentialsAccountController } from './credentials-account.controller';
import { CredentialsAccountService } from './credentials-account.service';
import { CredentialsPolicyController } from './credentials-policy.controller';
import { CredentialsProfileController } from './credentials-profile.controller';
import { CredentialsProfileService } from './credentials-profile.service';

/**
 * Credentials backend module. Depends on the globally-registered
 * `CredentialsVaultModule` (encryption + rate limiter) and
 * `AuditEventModule` (append-only audit stream). Settings-driven
 * policy values (vault session TTL, reveal auto-hide) are read via
 * `SettingsService`. The Credentials-attachments feature was removed
 * in this release — no attachment service / module here anymore.
 */
@Module({
  imports: [AuthModule, SettingsModule, DiscordIntegrationModule],
  controllers: [
    CredentialsProfileController,
    CredentialsAccountController,
    CredentialsPolicyController,
  ],
  providers: [
    CredentialsProfileService,
    CredentialsAccountService,
    CredentialChangeNotifierService,
  ],
  exports: [CredentialsProfileService, CredentialsAccountService],
})
export class CredentialsModule {}
