import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { ChatMessageStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AttachmentQueueService } from './attachment-queue.service';

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachmentQueue: AttachmentQueueService,
  ) {}

  saveUser(
    chatId: string,
    content: string,
    status: ChatMessageStatus = ChatMessageStatus.READY_FOR_AI,
  ) {
    const trimmed = content.trim();
    if (!trimmed)
      throw new BadRequestException('Message content cannot be empty');
    return this.prisma.chatMessage.create({
      data: { chatId, role: 'user', content: trimmed, status },
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
      data: {
        chatId,
        role: 'assistant',
        content,
        status: ChatMessageStatus.DONE,
        decision,
        reasoning,
      },
    });
  }

  getAttachmentsForMessage(messageId: string) {
    return this.prisma.messageAttachment.findMany({ where: { messageId } });
  }

  async addAttachment(
    messageId: string,
    fileName: string,
    mimeType?: string,
    fileUrl?: string,
  ) {
    const attachment = await this.prisma.messageAttachment.create({
      data: { messageId, fileName, mimeType, fileUrl },
    });

    this.attachmentQueue.enqueue(attachment.id).catch((err: unknown) => {
      this.logger.error(
        `failed to enqueue attachment ${attachment.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    });

    return attachment;
  }
}
