import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

import { SettingKey } from '../settings/setting-keys';
import { SettingsService } from '../settings/settings.service';
import { createTelegramClient } from './telegram-client.factory';
import { TelegramListenerService } from './telegram-listener.service';

@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);

  private authClient: TelegramClient | null = null;
  private phoneCodeHash: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly listener: TelegramListenerService,
  ) {}

  async startAuth(): Promise<void> {
    const { apiId, apiHash } = this.getCredentials();
    const phone = this.config.getOrThrow<string>('TG_PHONE');

    if (this.authClient?.connected) {
      await this.authClient.disconnect();
    }

    this.authClient = createTelegramClient(new StringSession(''), apiId, apiHash);

    await this.authClient.connect();

    const result = await this.authClient.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );

    if (!(result instanceof Api.auth.SentCode)) {
      throw new Error('Unexpected sendCode response: SentCodeSuccess received');
    }

    this.phoneCodeHash = result.phoneCodeHash;
    this.logger.log('Auth code sent');
  }

  async verifyCode(code: string): Promise<void> {
    if (!this.authClient || !this.phoneCodeHash) {
      throw new Error('Call startAuth() first');
    }

    const phone = this.config.getOrThrow<string>('TG_PHONE');

    await this.authClient.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: this.phoneCodeHash,
        phoneCode: code,
      }),
    );

    const sessionString = this.authClient.session.save() as unknown as string;

    await this.settings.setSetting(SettingKey.JOB_SCANNER_TELEGRAM_SESSION, sessionString);
    await this.settings.setSetting(SettingKey.JOB_SCANNER_TELEGRAM_CONNECTED, true);

    this.logger.log('Telegram authorized, session saved');

    try {
      await this.authClient.disconnect();
    } catch {
      // ignored
    }
    this.authClient = null;
    this.phoneCodeHash = null;

    await this.listener.reconnect();
  }

  async logout(): Promise<void> {
    await this.listener.disconnect();

    await this.settings.setSetting(SettingKey.JOB_SCANNER_TELEGRAM_SESSION, '');
    await this.settings.setSetting(SettingKey.JOB_SCANNER_TELEGRAM_CONNECTED, false);

    if (this.authClient?.connected) {
      try {
        await this.authClient.invoke(new Api.auth.LogOut());
        await this.authClient.disconnect();
      } catch {
        // ignored
      }
      this.authClient = null;
    }

    this.logger.log('Telegram logged out');
  }

  private getCredentials() {
    return {
      apiId: Number(this.config.getOrThrow<string>('TG_API_ID')),
      apiHash: this.config.getOrThrow<string>('TG_API_HASH'),
    };
  }
}
