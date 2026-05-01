import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class MessageService {
  constructor(private readonly prisma: PrismaService) {}

  saveUser(chatId: string, content: string) {
    const trimmed = content.trim();
    if (!trimmed)
      throw new BadRequestException('Message content cannot be empty');
    return this.prisma.chatMessage.create({
      data: { chatId, role: 'user', content: trimmed },
    });
  }

  count(chatId: string): Promise<number> {
    return this.prisma.chatMessage.count({ where: { chatId } });
  }

  saveAssistant(
    chatId: string,
    content: string,
    decision?: string,
    reasoning?: string,
  ) {
    return this.prisma.chatMessage.create({
      data: { chatId, role: 'assistant', content, decision, reasoning },
    });
  }
}
