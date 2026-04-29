import * as path from 'path';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';

import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { IncomingFileData, StorageBucket, StorageService, StoredFileMetadata } from '../storage';
import { CreateClientRequestDto } from './dto/create-client-request.dto';
import { UpdateClientRequestDto } from './dto/update-client-request.dto';

@Injectable()
export class ClientRequestsService {
  private readonly logger = new Logger(ClientRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly storage: StorageService,
  ) {}

  async findAll(page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.clientRequest.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.clientRequest.count(),
    ]);

    return { data, total };
  }

  async findOne(id: string) {
    const request = await this.prisma.clientRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Client request not found');
    return request;
  }

  async update(id: string, dto: UpdateClientRequestDto) {
    const request = await this.prisma.clientRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Client request not found');

    return this.prisma.clientRequest.update({
      where: { id },
      data: {
        name: dto.name,
        company: dto.company,
        email: dto.email,
        phone: dto.phone,
        phoneCountry: dto.phoneCountry,
        message: dto.message,
        services: dto.services,
        status: dto.status,
      },
    });
  }

  async remove(id: string) {
    const request = await this.findOne(id);
    const storedFiles = (request.files as unknown) as StoredFileMetadata[];
    const folderPrefix = storedFiles.length > 0
      ? storedFiles[0].fileName.split('/')[0] + '/'
      : `${id}/`;
    await this.storage.deleteFolder(StorageBucket.CLIENT_REQUESTS, folderPrefix);
    await this.prisma.clientRequest.delete({ where: { id } });
  }

  async getFilesDownloadUrls(id: string): Promise<{ originalName: string; url: string; mimetype: string; size: number }[]> {
    const request = await this.findOne(id);
    const storedFiles = (request.files as unknown) as StoredFileMetadata[];

    return Promise.all(
      storedFiles.map(async (f) => ({
        originalName: f.originalName,
        mimetype: f.mimetype,
        size: f.size,
        url: await this.storage.getDownloadUrl(StorageBucket.CLIENT_REQUESTS, f.fileName),
      })),
    );
  }

  async create(dto: CreateClientRequestDto, files: IncomingFileData[]) {
    const request = await this.prisma.clientRequest.create({
      data: {
        name: dto.name,
        company: dto.company,
        email: dto.email,
        phone: dto.phone,
        phoneCountry: dto.phoneCountry,
        message: dto.message,
        services: dto.services ?? [],
        files: [],
      },
    });

    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const d = request.createdAt;
    const shortId = request.id.slice(0, 8);
    const folderName = `${request.name} - ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} (${shortId})`
      .replace(/[^\p{L}\p{N} \-_.,()]/gu, '')
      .trim();

    const storedFiles: StoredFileMetadata[] = await Promise.all(
      files.map(async (file) => {
        const ext = path.extname(file.originalName);
        const baseName = path
          .basename(file.originalName, ext)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60);
        const fileName = `${folderName}/${new Date().toISOString().slice(0, 10)}-${baseName}${ext}`;

        const { fileId, url } = await this.storage.upload({
          bucket: StorageBucket.CLIENT_REQUESTS,
          fileName,
          buffer: file.buffer,
          mimeType: file.mimetype,
        });

        return {
          originalName: file.originalName,
          fileName,
          fileId,
          url,
          mimetype: file.mimetype,
          size: file.size,
        };
      }),
    );

    if (storedFiles.length > 0) {
      await this.prisma.clientRequest.update({
        where: { id: request.id },
        data: { files: storedFiles as object[] },
      });
    }

    try {
      await this.notificationService.createEvent(NotificationType.CLIENT_REQUEST, {
        clientRequestId: request.id,
        name: request.name,
        email: request.email,
        company: request.company ?? null,
        phone: request.phone ?? null,
        phoneCountry: request.phoneCountry ?? null,
        services: request.services,
        message: request.message ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Failed to create NotificationEvent for clientRequest ${request.id}: ${(err as Error).message}`,
      );
    }

    return request;
  }
}