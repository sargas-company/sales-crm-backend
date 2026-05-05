import { readFile } from 'fs/promises';

import { Injectable, Logger } from '@nestjs/common';
import {
  ChatMessage,
  MessageAttachment,
  MessageAttachmentStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage';
import { formatAttachmentBlock } from './attachment-formatter';
import { FileParserService } from './file-parser.service';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

@Injectable()
export class AttachmentPreprocessorService {
  private readonly logger = new Logger(AttachmentPreprocessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileParser: FileParserService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Reads already-parsed attachment data from DB and embeds textRepresentation
   * into message.content in-memory. Does NOT trigger parsing — that is handled
   * by AttachmentProcessorService via BullMQ.
   */
  async processMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
    if (messages.length === 0) return messages;

    const messageIds = messages.map((m) => m.id);

    const attachments = await this.prisma.messageAttachment.findMany({
      where: { messageId: { in: messageIds } },
      orderBy: { createdAt: 'asc' },
    });

    if (attachments.length === 0) return messages;

    const byMessageId = new Map<string, MessageAttachment[]>();
    for (const a of attachments) {
      const list = byMessageId.get(a.messageId) ?? [];
      list.push(a);
      byMessageId.set(a.messageId, list);
    }

    return messages.map((message) => {
      const msgAttachments = byMessageId.get(message.id);
      if (!msgAttachments?.length) return message;

      // Strip previously embedded blocks so stale placeholders are replaced
      // by the current state (e.g. placeholder → real text after parsing).
      const cleanContent = this.stripAttachmentBlocks(message.content);
      const appendix = msgAttachments
        .map((a) => formatAttachmentBlock(a))
        .join('\n\n');
      return { ...message, content: `${cleanContent}\n\n${appendix}` };
    });
  }

  /**
   * Parses the file from an in-memory buffer and saves the result to DB.
   * Used by the controller right after upload — avoids an extra HTTP round-trip
   * to re-download a file that is already in memory.
   */
  async parseFromBuffer(
    attachment: MessageAttachment,
    buffer: Buffer,
  ): Promise<void> {
    const status = (attachment as unknown as { status?: string }).status;
    if (status === 'DONE' || status === 'FAILED' || status === 'TIMEOUT') {
      return;
    }

    const mimeType = this.resolveMimeType(attachment);

    await this.setStatus(attachment.id, MessageAttachmentStatus.PROCESSING);

    if (mimeType.startsWith('image/')) {
      await this.prisma.messageAttachment.update({
        where: {
          id: attachment.id,
          status: MessageAttachmentStatus.PROCESSING,
        },
        data: {
          status: MessageAttachmentStatus.DONE,
          textRepresentation: null,
        },
      });
      this.logger.log(
        `attachment ${attachment.id} is an image — marked DONE without text`,
      );
      return;
    }

    try {
      this.logger.debug(
        `parsing attachment ${attachment.id} from buffer | mime=${mimeType}`,
      );
      const text = await this.fileParser.parse(buffer, mimeType);

      if (!text.trim()) {
        await this.prisma.messageAttachment.update({
          where: {
            id: attachment.id,
            status: MessageAttachmentStatus.PROCESSING,
          },
          data: {
            status: MessageAttachmentStatus.DONE,
            textRepresentation: null,
          },
        });
        this.logger.warn(
          `attachment ${attachment.id} (${attachment.fileName}) produced no text — marked DONE`,
        );
        return;
      }

      await this.prisma.messageAttachment.update({
        where: {
          id: attachment.id,
          status: MessageAttachmentStatus.PROCESSING,
        },
        data: {
          status: MessageAttachmentStatus.DONE,
          textRepresentation: text,
        },
      });
      this.logger.log(
        `parsed attachment ${attachment.id} | ${attachment.fileName} | ${text.length} chars`,
      );
    } catch (error) {
      this.logger.error(
        `failed to parse attachment ${attachment.id} (${attachment.fileName}) from buffer`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async parseAndSave(attachment: MessageAttachment): Promise<void> {
    const status = (attachment as unknown as { status?: string }).status;

    // Skip terminal states — status is the single source of truth
    if (status === 'DONE' || status === 'FAILED' || status === 'TIMEOUT') {
      return;
    }

    if (!attachment.fileUrl) return;

    const mimeType = this.resolveMimeType(attachment);

    await this.setStatus(attachment.id, MessageAttachmentStatus.PROCESSING);

    // Images: mark DONE without text extraction
    if (mimeType.startsWith('image/')) {
      await this.prisma.messageAttachment.update({
        where: {
          id: attachment.id,
          status: MessageAttachmentStatus.PROCESSING,
        },
        data: {
          status: MessageAttachmentStatus.DONE,
          textRepresentation: null,
        },
      });
      this.logger.log(
        `attachment ${attachment.id} is an image — marked DONE without text`,
      );
      return;
    }

    try {
      this.logger.debug(
        `parsing attachment ${attachment.id} | mime=${mimeType}`,
      );
      const buffer = await this.fetchFile(attachment.fileUrl);
      const text = await this.fileParser.parse(buffer, mimeType);

      if (!text.trim()) {
        // Unsupported / empty content — terminal DONE, no retry
        await this.prisma.messageAttachment.update({
          where: {
            id: attachment.id,
            status: MessageAttachmentStatus.PROCESSING,
          },
          data: {
            status: MessageAttachmentStatus.DONE,
            textRepresentation: null,
          },
        });
        this.logger.warn(
          `attachment ${attachment.id} (${attachment.fileName}) produced no text — marked DONE`,
        );
        return;
      }

      await this.prisma.messageAttachment.update({
        where: {
          id: attachment.id,
          status: MessageAttachmentStatus.PROCESSING,
        },
        data: {
          status: MessageAttachmentStatus.DONE,
          textRepresentation: text,
        },
      });

      this.logger.log(
        `parsed attachment ${attachment.id} | ${attachment.fileName} | ${text.length} chars`,
      );
    } catch (error) {
      this.logger.error(
        `failed to parse attachment ${attachment.id} (${attachment.fileName})`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error; // re-throw so caller (worker / controller) decides on retry
    }
  }

  /**
   * Polls until all attachments for a message reach a terminal state
   * (DONE, FAILED, TIMEOUT) or the timeout elapses.
   * On timeout, pending/processing attachments are marked TIMEOUT.
   */
  async waitForAttachments(
    messageId: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const POLL_INTERVAL_MS = 400;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const attachments = await this.prisma.messageAttachment.findMany({
        where: { messageId },
        select: { status: true },
      });

      if (attachments.length === 0) return;

      const allTerminal = attachments.every((a) => {
        const s = (a as unknown as { status?: string }).status;
        return s === 'DONE' || s === 'FAILED' || s === 'TIMEOUT';
      });

      if (allTerminal) return;

      await new Promise<void>((resolve) =>
        setTimeout(resolve, POLL_INTERVAL_MS),
      );
    }

    // Timeout reached — mark still-pending/processing attachments
    // 'TIMEOUT' cast: value exists in schema but client regeneration is pending
    await this.prisma.messageAttachment.updateMany({
      where: {
        messageId,
        status: {
          in: [
            MessageAttachmentStatus.PENDING,
            MessageAttachmentStatus.PROCESSING,
          ],
        },
      },
      data: { status: 'TIMEOUT' as never },
    });

    this.logger.warn(
      `waitForAttachments timed out for message ${messageId} after ${timeoutMs}ms`,
    );
  }

  private stripAttachmentBlocks(content: string): string {
    // Matches only well-formed blocks our formatter produces:
    //   "Attached file:\nFile name: {name}\n\nContent:\n{text}"
    // Requires the exact Content: marker so user text is never affected.
    return content
      .replace(
        /\n+Attached file:\nFile name:[^\n]+\n\nContent:\n[\s\S]*?(?=\n\nAttached file:|$)/g,
        '',
      )
      .trimEnd();
  }

  private async setStatus(
    id: string,
    status: MessageAttachmentStatus,
  ): Promise<void> {
    await this.prisma.messageAttachment.update({
      where: { id },
      data: { status },
    });
  }

  private resolveMimeType(attachment: MessageAttachment): string {
    const mime = attachment.mimeType ?? this.guessMimeType(attachment.fileName);
    if (!mime || mime === 'application/octet-stream') {
      return this.guessMimeType(attachment.fileName);
    }
    return mime;
  }

  private async fetchFile(fileUrl: string): Promise<Buffer> {
    // Local absolute path — read directly from disk (no HTTP round-trip)
    if (!fileUrl.startsWith('http')) {
      const buf = await readFile(fileUrl);
      if (buf.length > MAX_FILE_SIZE) {
        throw new Error(`file too large: ${buf.length} bytes`);
      }
      return buf;
    }

    // B2 private bucket — generate a signed URL to avoid 401
    const signedUrl = await this.storage
      .getSignedUrlFromRawUrl(fileUrl)
      .catch((err: unknown) => {
        this.logger.warn(
          `could not generate signed URL for ${fileUrl}: ${String(err)} — falling back to raw URL`,
        );
        return null;
      });

    const fetchUrl = signedUrl ?? fileUrl;
    if (signedUrl) {
      this.logger.debug(`using signed URL for attachment fetch`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(fetchUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`fetch ${response.status} ${response.statusText}`);
      }

      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength && contentLength > MAX_FILE_SIZE) {
        throw new Error(`file too large: ${contentLength} bytes`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(
          `file too large after download: ${buffer.length} bytes`,
        );
      }

      return buffer;
    } finally {
      clearTimeout(timeout);
    }
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
  }
}
