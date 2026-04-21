import * as fs from 'fs';
import * as path from 'path';

import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateClientRequestDto } from './dto/create-client-request.dto';
import { UpdateClientRequestDto } from './dto/update-client-request.dto';

export interface UploadedFileMetadata {
  originalName: string;
  fileName: string;
  path: string;
  mimetype: string;
  size: number;
}

@Injectable()
export class ClientRequestsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const request = await this.prisma.clientRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Client request not found');

    await this.prisma.clientRequest.delete({ where: { id } });

    const files = (request.files as unknown) as UploadedFileMetadata[];
    for (const file of files) {
      const fullPath = path.join(process.cwd(), file.path);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  }

  async create(dto: CreateClientRequestDto, files: UploadedFileMetadata[]) {
    return this.prisma.clientRequest.create({
      data: {
        name: dto.name,
        company: dto.company,
        email: dto.email,
        phone: dto.phone,
        phoneCountry: dto.phoneCountry,
        message: dto.message,
        services: dto.services ?? [],
        files: files as object[],
      },
    });
  }
}
