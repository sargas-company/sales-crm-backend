import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateCounterpartyDto } from './dto/create-counterparty.dto';
import { UpdateCounterpartyDto } from './dto/update-counterparty.dto';

@Injectable()
export class CounterpartyService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCounterpartyDto) {
    return this.prisma.counterparty.create({ data: dto });
  }

  async findAll(page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.counterparty.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.counterparty.count(),
    ]);

    return { data, total };
  }

  async findOne(id: string) {
    const counterparty = await this.prisma.counterparty.findUnique({ where: { id } });
    if (!counterparty) throw new NotFoundException('Counterparty not found');
    return counterparty;
  }

  async update(id: string, dto: UpdateCounterpartyDto) {
    await this.findOne(id);
    return this.prisma.counterparty.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.counterparty.delete({ where: { id } });
  }
}
