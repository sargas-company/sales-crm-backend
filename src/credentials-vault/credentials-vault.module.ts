import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { CredentialEncryptionService } from './encryption.service';
import { MfaService } from './mfa.service';
import { VaultRateLimiterService } from './rate-limiter.service';
import { VaultController } from './vault.controller';
import { VaultSessionGuard } from './vault-session.guard';
import { VaultSessionService } from './vault-session.service';

/**
 * Global vault module: encryption, rate limiter, MFA (WebAuthn + TOTP
 * + recovery), vault session lifecycle, and the guard that gates
 * reveal / hard-delete endpoints.
 */
@Global()
@Module({
  imports: [ConfigModule, AuthModule, SettingsModule],
  controllers: [VaultController],
  providers: [
    CredentialEncryptionService,
    VaultRateLimiterService,
    MfaService,
    VaultSessionService,
    VaultSessionGuard,
  ],
  exports: [
    CredentialEncryptionService,
    VaultRateLimiterService,
    MfaService,
    VaultSessionService,
    VaultSessionGuard,
  ],
})
export class CredentialsVaultModule {}
