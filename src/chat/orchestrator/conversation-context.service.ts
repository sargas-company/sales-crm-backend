import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { HISTORY_LIMIT } from './pipeline.config';

@Injectable()
export class ConversationContextService {
  constructor(private readonly prisma: PrismaService) {}

  async getHistory(chatId: string, limit = HISTORY_LIMIT) {
    const messages = await this.prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return messages.reverse();
  }
}
