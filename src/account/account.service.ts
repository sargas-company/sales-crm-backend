import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { PlatformService } from '../platform/platform.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

const ACCOUNT_INCLUDE = { platform: true } as const;

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformService: PlatformService,
  ) {}

  async create(dto: CreateAccountDto, userId: string) {
    await this.platformService.findOne(dto.platformId);

    return this.prisma.account.create({
      data: { firstName: dto.firstName, lastName: dto.lastName, platformId: dto.platformId, userId },
      include: ACCOUNT_INCLUDE,
    });
  }

  findAll(userId: string) {
    return this.prisma.account.findMany({
      where: { userId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      include: ACCOUNT_INCLUDE,
    });
  }

  async findOne(id: string, userId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, userId },
      include: ACCOUNT_INCLUDE,
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async update(id: string, dto: UpdateAccountDto, userId: string) {
    await this.findOne(id, userId);

    if (dto.platformId) {
      await this.platformService.findOne(dto.platformId);
    }

    return this.prisma.account.update({
      where: { id },
      data: { firstName: dto.firstName, lastName: dto.lastName, platformId: dto.platformId },
      include: ACCOUNT_INCLUDE,
    });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    return this.prisma.account.delete({ where: { id } });
  }
}
