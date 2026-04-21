import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateClientRequestDto } from './dto/create-client-request.dto';

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
