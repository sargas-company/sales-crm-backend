import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class DiscordNotificationService {
  private readonly logger = new Logger(DiscordNotificationService.name);

  constructor(private readonly config: ConfigService) {}

  async send(body: Record<string, unknown>): Promise<void> {
    const url = this.config.get<string>('DISCORD_WEBHOOK_URL');

    if (!url) {
      throw new Error('DISCORD_WEBHOOK_URL is not configured');
    }

    const response = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });

    this.logger.debug(`Discord webhook response: ${response.status}`);
  }
}
