import { extname } from 'path';
import { randomUUID } from 'crypto';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';

import { MessageAttachment } from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageBucket, StorageService } from '../storage';
import { AttachmentPreprocessorService } from './orchestrator/attachment-preprocessor.service';
import { AttachmentQueueService } from './orchestrator/attachment-queue.service';
import { ChatMessageOrchestratorService } from './orchestrator/chat-message-orchestrator.service';
import { MessageService } from './orchestrator/message.service';
import { RuntimeDomainContextService } from './orchestrator/runtime-domain-context.service';
import { ChatGateway } from './chat.gateway';
import { SendMessageDto } from './dto/send-message.dto';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/markdown',
  'text/csv',
  'image/jpeg',
  'image/png',
]);

const multerOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    cb: (err: Error | null, accept: boolean) => void,
  ) => {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new BadRequestException(`Unsupported file type: ${file.mimetype}`),
        false,
      );
    }
  },
};

@ApiTags('Chat')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('proposals')
export class ProposalChatController {
  private readonly logger = new Logger(ProposalChatController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly runtimeContext: RuntimeDomainContextService,
    private readonly messageService: MessageService,
    private readonly attachmentPreprocessor: AttachmentPreprocessorService,
    private readonly attachmentQueue: AttachmentQueueService,
    private readonly orchestrator: ChatMessageOrchestratorService,
    private readonly gateway: ChatGateway,
  ) {}

  @Post(':id/chat')
  @UseInterceptors(FilesInterceptor('files', 10, multerOptions))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Send a message (with optional files) to the AI chat',
  })
  @ApiResponse({
    status: 200,
    description: 'Pipeline started, streaming via WebSocket',
  })
  async sendMessage(
    @Param('id') proposalId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: SendMessageDto,
    @Request() req: { user: { id: string } },
  ): Promise<{ status: string; messageId: string }> {
    const userId = req.user.id;
    const { socketId } = dto;

    this.logger.log(
      `sendMessage | proposal=${proposalId} user=${userId} files=${files?.length ?? 0} socket=${socketId}`,
    );

    const socket = this.gateway.getSocket(socketId);
    if (!socket) {
      this.logger.warn(
        `socket ${socketId} not found — stream events will be dropped`,
      );
    }

    const chat = await this.runtimeContext.findOrCreateChat(proposalId, userId);
    this.logger.debug(`chat resolved | id=${chat.id} proposal=${proposalId}`);

    const message = await this.messageService.saveUser(chat.id, dto.content);
    this.logger.log(`message created | id=${message.id} chat=${chat.id}`);

    if (files?.length) {
      this.logger.log(
        `processing ${files.length} attachment(s) for message ${message.id}`,
      );

      for (const file of files) {
        this.logger.log(
          `attachment upload start | file="${file.originalname}" mime=${file.mimetype} size=${file.size}B`,
        );

        let attachment: MessageAttachment;
        try {
          const fileName = `${message.id}/${Date.now()}-${randomUUID()}${extname(file.originalname)}`;

          const uploadStart = Date.now();
          const { url } = await this.storage.upload({
            bucket: StorageBucket.CHAT_ATTACHMENTS,
            fileName,
            buffer: file.buffer,
            mimeType: file.mimetype,
          });
          this.logger.log(
            `attachment uploaded to B2 | file="${file.originalname}" b2Key=${fileName} url=${url} duration=${Date.now() - uploadStart}ms`,
          );

          attachment = await this.prisma.messageAttachment.create({
            data: {
              messageId: message.id,
              fileName: file.originalname,
              mimeType: file.mimetype,
              fileUrl: url,
            },
          });
          this.logger.log(
            `attachment record created | id=${attachment.id} messageId=${message.id} fileUrl=${url}`,
          );
        } catch (err) {
          this.logger.error(
            `failed to upload/create attachment | file="${file.originalname}" message=${message.id}`,
            err instanceof Error ? err.stack : String(err),
          );
          continue;
        }

        socket?.emit('attachment_processing', {
          attachmentId: attachment.id,
          fileName: file.originalname,
        });

        try {
          this.logger.debug(
            `parsing attachment | id=${attachment.id} mime=${file.mimetype}`,
          );
          const parseStart = Date.now();
          await this.attachmentPreprocessor.parseFromBuffer(
            attachment,
            file.buffer,
          );
          this.logger.log(
            `attachment parsed | id=${attachment.id} duration=${Date.now() - parseStart}ms`,
          );
          socket?.emit('attachment_ready', {
            attachmentId: attachment.id,
            fileName: file.originalname,
          });
        } catch (parseErr) {
          this.logger.warn(
            `immediate parse failed for ${attachment.id} ("${file.originalname}"), queuing for retry`,
          );
          socket?.emit('attachment_error', {
            attachmentId: attachment.id,
            fileName: file.originalname,
            message: 'File processing failed, retrying in background',
          });
          this.attachmentQueue.enqueue(attachment.id).catch((e: unknown) => {
            this.logger.error(
              `enqueue failed for attachment ${attachment.id}: ${String(e)}`,
            );
          });
        }
      }
    }

    this.runPipeline(proposalId, dto.content, userId, message.id, socketId);

    return { status: 'processing', messageId: message.id };
  }

  @Get(':id/chat/messages')
  @ApiOperation({
    summary: 'Get chat message history with attachment metadata',
  })
  async getMessages(
    @Param('id') proposalId: string,
    @Request() req: { user: { id: string } },
  ) {
    const chat = await this.prisma.chat.findFirst({
      where: {
        proposal: { id: proposalId, userId: req.user.id },
      },
    });

    if (!chat) return { messages: [] };

    const messages = await this.prisma.chatMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'asc' },
      include: {
        attachments: {
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    return { messages };
  }

  @Get(':id/chat/attachments/:attachmentId/url')
  @ApiOperation({ summary: 'Get a signed download URL for an attachment' })
  async getAttachmentUrl(
    @Param('id') proposalId: string,
    @Param('attachmentId') attachmentId: string,
    @Request() req: { user: { id: string } },
  ) {
    const attachment = await this.prisma.messageAttachment.findFirst({
      where: {
        id: attachmentId,
        message: {
          chat: {
            proposal: { id: proposalId, userId: req.user.id },
          },
        },
      },
    });

    if (!attachment) throw new NotFoundException('Attachment not found');
    if (!attachment.fileUrl) throw new NotFoundException('File URL not set');

    const url = await this.storage.getSignedUrlFromRawUrl(attachment.fileUrl);
    if (!url) throw new NotFoundException('Could not generate download URL');

    this.logger.debug(`signed URL generated | attachmentId=${attachmentId}`);

    return { url };
  }

  private runPipeline(
    proposalId: string,
    content: string,
    userId: string,
    messageId: string,
    socketId: string,
  ): void {
    void (async () => {
      const socket = this.gateway.getSocket(socketId);
      if (!socket) {
        this.logger.warn(
          `socket ${socketId} not found — response will not be streamed`,
        );
        return;
      }

      this.logger.log(
        `pipeline started | proposal=${proposalId} message=${messageId} socket=${socketId}`,
      );

      try {
        socket.emit('thinking');

        const stream = this.orchestrator.streamMessage(
          proposalId,
          content,
          userId,
          messageId,
        );

        this.logger.debug(`streaming started | socket=${socketId}`);

        for await (const event of stream) {
          socket.emit('chunk', { text: event.text });
        }

        socket.emit('done');
        this.logger.log(
          `pipeline done | proposal=${proposalId} socket=${socketId}`,
        );
      } catch (err) {
        this.logger.error(
          `pipeline failed | proposal=${proposalId} message=${messageId}`,
          err instanceof Error ? err.stack : String(err),
        );
        socket.emit('error', {
          message: err instanceof Error ? err.message : 'AI pipeline error',
        });
      }
    })();
  }
}
