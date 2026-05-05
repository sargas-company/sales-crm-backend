import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ConversationContextService {
  constructor(private readonly prisma: PrismaService) {}

  async getHistory(chatId: string, limit?: number) {
    const messages = await this.prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      ...(limit !== undefined ? { take: limit } : {}),
    });
    return messages.reverse();
  }
}
