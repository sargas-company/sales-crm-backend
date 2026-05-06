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

import { ChatMessageStatus, MessageAttachment } from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageBucket, StorageService } from '../storage';
import { AttachmentQueueService } from './orchestrator/attachment-queue.service';
import { MessageReadinessService } from './orchestrator/message-readiness.service';
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
    private readonly attachmentQueue: AttachmentQueueService,
    private readonly readiness: MessageReadinessService,
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
    description: 'Message queued — AI response streams via WebSocket proposal room',
  })
  async sendMessage(
    @Param('id') proposalId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: SendMessageDto,
    @Request() req: { user: { id: string } },
  ): Promise<{ status: string; messageId: string }> {
    const userId = req.user.id;

    this.logger.log(
      `sendMessage | proposal=${proposalId} user=${userId} files=${files?.length ?? 0}`,
    );

    const chat = await this.runtimeContext.findOrCreateChat(proposalId, userId);
    this.logger.debug(`chat resolved | id=${chat.id} proposal=${proposalId}`);

    // Auto-join the sender's socket to the proposal room so all subsequent
    // room broadcasts (thinking, chunk, done, message_updated) reach the client.
    // Supports clients that haven't migrated to explicit join_proposal yet.
    if (dto.socketId) {
      const socket = this.gateway.getSocket(dto.socketId);
      if (socket && !this.gateway.isInProposalRoom(socket, proposalId)) {
        const room = this.gateway.getProposalRoom(proposalId);
        await socket.join(room);
      }
    }

    const initialStatus = files?.length
      ? ChatMessageStatus.PREPARING_ATTACHMENTS
      : ChatMessageStatus.READY_FOR_AI;

    const message = await this.messageService.saveUser(
      chat.id,
      dto.content,
      initialStatus,
    );
    this.logger.log(`message created | id=${message.id} chat=${chat.id}`);

    if (files?.length) {
      this.logger.log(
        `uploading ${files.length} attachment(s) for message ${message.id}`,
      );

      for (const file of files) {
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
            `attachment uploaded | file="${file.originalname}" duration=${Date.now() - uploadStart}ms`,
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
            `attachment record created | id=${attachment.id} messageId=${message.id}`,
          );
        } catch (err) {
          this.logger.error(
            `failed to upload/create attachment | file="${file.originalname}" message=${message.id}`,
            err instanceof Error ? err.stack : String(err),
          );
          continue;
        }

        await this.attachmentQueue
          .enqueue(attachment.id)
          .catch((e: unknown) => {
            this.logger.error(
              `enqueue failed for attachment ${attachment.id}: ${String(e)}`,
            );
          });
      }
    } else {
      // Text-only: AI triggered via readiness engine (same path as file messages)
      this.logger.log(
        `text-only message ${message.id} — routing to readiness engine`,
      );
      void this.readiness
        .checkMessageReadiness(message.id, dto.socketId)
        .catch((e: unknown) => {
          this.logger.error(
            `readiness check failed for text-only message ${message.id}`,
            e instanceof Error ? e.stack : String(e),
          );
        });
    }

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
      select: {
        id: true,
        chatId: true,
        role: true,
        content: true,
        status: true,
        decision: true,
        reasoning: true,
        createdAt: true,
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
}
