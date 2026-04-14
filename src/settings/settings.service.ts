import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

const SETTINGS_ID = 'global';

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    const settings = await this.prisma.settings.findUnique({
      where: { id: SETTINGS_ID },
    });
    return settings ?? { id: SETTINGS_ID, systemPrompt: '' };
  }

  async update(systemPrompt: string) {
    if (!systemPrompt?.trim()) throw new BadRequestException('systemPrompt is required');
    return this.prisma.settings.upsert({
      where: { id: SETTINGS_ID },
      update: { systemPrompt },
      create: { id: SETTINGS_ID, systemPrompt },
    });
  }
}
