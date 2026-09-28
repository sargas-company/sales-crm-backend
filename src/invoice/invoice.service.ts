import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { InvoiceStatus, Prisma } from '@prisma/client';

import { AuthUser, scopePolicy } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StorageBucket, StorageService } from '../storage';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import {
  InvoiceSortBy,
  InvoiceSortDirection,
  ListInvoicesDto,
} from './dto/list-invoices.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';

@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  async create(dto: CreateInvoiceDto, user: AuthUser) {
    const cp = await this.prisma.counterparty.findUnique({
      where: { id: dto.counterpartyId },
      select: { type: true },
    });
    if (!cp) throw new NotFoundException('Counterparty not found');
    // Scope check: creating an invoice against a contractor
    // counterparty requires `contractor_scope:manage`.
    scopePolicy.assertCanManageType(user, cp.type);

    const { lineItems, ...invoiceData } = dto;

    return this.prisma.invoice.create({
      data: {
        ...invoiceData,
        date: invoiceData.date ? new Date(invoiceData.date) : undefined,
        dueDate: invoiceData.dueDate
          ? new Date(invoiceData.dueDate)
          : undefined,
        labels: invoiceData.labels ?? {},
        customFields: invoiceData.customFields ?? [],
        lineItems: lineItems?.length ? { create: lineItems } : undefined,
      },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
  }

  async findAll(dto: ListInvoicesDto, user: AuthUser) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? InvoiceSortDirection.desc;
    const visibleTypes = scopePolicy.visibleTypes(user);

    const where: Prisma.InvoiceWhereInput = {
      counterparty: { type: { in: visibleTypes } },
      ...(dto.search
        ? { number: { contains: dto.search, mode: 'insensitive' } }
        : {}),
    };

    const orderBy = this.buildOrderBy(dto.sortBy, dir);

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        include: { counterparty: true },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data, total };
  }

  private buildOrderBy(
    sortBy: InvoiceSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.InvoiceOrderByWithRelationInput {
    switch (sortBy) {
      case InvoiceSortBy.number:
        return { number: { sort: dir, nulls: 'last' } };
      case InvoiceSortBy.counterparty:
        return { counterparty: { firstName: dir } };
      case InvoiceSortBy.status:
        return { status: dir };
      case InvoiceSortBy.date:
        return { date: { sort: dir, nulls: 'last' } };
      case InvoiceSortBy.dueDate:
        return { dueDate: { sort: dir, nulls: 'last' } };
      case InvoiceSortBy.currency:
        return { currency: dir };
      case InvoiceSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  async findOne(id: string, user: AuthUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    scopePolicy.assertCanReadType(user, invoice.counterparty.type);
    return invoice;
  }

  async update(id: string, dto: UpdateInvoiceDto, user: AuthUser) {
    const existing = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
    if (!existing) throw new NotFoundException('Invoice not found');
    // Contractor-scope: any mutation on a contractor invoice requires
    // `contractor_scope:manage`.
    scopePolicy.assertCanManageType(user, existing.counterparty.type);

    if (dto.status === 'paid' && !existing.pdfUrl) {
      throw new BadRequestException(
        'Cannot set status to paid: invoice PDF has not been generated yet',
      );
    }

    const { lineItems, ...invoiceData } = dto;

    return this.prisma.$transaction(async (tx) => {
      if (lineItems !== undefined) {
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
      }

      return tx.invoice.update({
        where: { id },
        data: {
          ...invoiceData,
          date: invoiceData.date ? new Date(invoiceData.date) : undefined,
          dueDate: invoiceData.dueDate
            ? new Date(invoiceData.dueDate)
            : undefined,
          lineItems: lineItems?.length ? { create: lineItems } : undefined,
        },
        include: {
          lineItems: { orderBy: { sortOrder: 'asc' } },
          counterparty: true,
        },
      });
    });
  }

  async remove(id: string, user: AuthUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    scopePolicy.assertCanManageType(user, invoice.counterparty.type);

    if (invoice.pdfUrl) {
      const fileName = invoice.pdfUrl.startsWith('http')
        ? decodeURIComponent(invoice.pdfUrl.split('/').pop()!)
        : invoice.pdfUrl;
      await this.storage.deleteByName(StorageBucket.INVOICES, fileName);
    }

    return this.prisma.invoice.delete({ where: { id } });
  }

  async getPdfDownloadUrl(id: string, user: AuthUser): Promise<string> {
    const invoice = await this.findOne(id, user);
    if (!invoice.pdfUrl) throw new NotFoundException('Invoice PDF has not been generated yet');
    // pdfUrl can be a full URL (old records) or plain filename (new records)
    const fileName = invoice.pdfUrl.startsWith('http')
      ? decodeURIComponent(invoice.pdfUrl.split('/').pop()!)
      : invoice.pdfUrl;
    return this.storage.getDownloadUrl(StorageBucket.INVOICES, fileName);
  }

  async generate(id: string, user: AuthUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    // Generate is a mutation (writes pdfUrl + status) so contractor
    // rows require `contractor_scope:manage`, matching update/delete.
    scopePolicy.assertCanManageType(user, invoice.counterparty.type);

    const MONTHS = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const formatDate = (d: Date | null) =>
      d
        ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
        : undefined;

    const payload = {
      from: invoice.fromValue || undefined,
      to: invoice.toValue || undefined,
      ship_to: invoice.shipTo || undefined,
      logo: 'https://sargas.io/logo.png',
      number: invoice.number || undefined,
      currency: invoice.currency,
      header: invoice.header,
      date: formatDate(invoice.date),
      due_date: formatDate(invoice.dueDate),
      payment_terms: invoice.paymentTerms || undefined,
      purchase_order: invoice.poNumber || undefined,
      notes: invoice.notes || undefined,
      terms: invoice.terms || undefined,
      tax: invoice.tax != null ? Number(invoice.tax) : undefined,
      discounts:
        invoice.discounts != null ? Number(invoice.discounts) : undefined,
      shipping: invoice.shipping != null ? Number(invoice.shipping) : undefined,
      amount_paid:
        invoice.amountPaid != null ? Number(invoice.amountPaid) : undefined,
      fields: {
        tax: invoice.showTax,
        discounts: invoice.showDiscounts,
        shipping: invoice.showShipping,
      },
      items: invoice.lineItems.map((item) => ({
        name: item.name,
        description: item.description || undefined,
        quantity: Number(item.quantity),
        unit_cost: Number(item.unitCost),
      })),
      custom_fields: invoice.customFields,
      ...(invoice.labels as Record<string, string>),
    };


    const apiKey = this.config.get<string>('INVOICE_GENERATOR_API_KEY');

    const response = await axios
      .post('https://invoice-generator.com', payload, {
        responseType: 'arraybuffer',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
        },
      })
      .catch((err) => {
        const msg = err.response?.data
          ? Buffer.from(err.response.data).toString()
          : err.message;
        throw new InternalServerErrorException(
          `Invoice Generator API error: ${msg}`,
        );
      });

    const cp = invoice.counterparty;
    const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const type = cp.type.charAt(0).toUpperCase() + cp.type.slice(1);
    const day = invoice.createdAt.getUTCDate();
    const month = FULL_MONTHS[invoice.createdAt.getUTCMonth()];
    const year = invoice.createdAt.getUTCFullYear();
    const shortId = id.slice(0, 8);
    const rawName = `${type} - ${cp.firstName} ${cp.lastName} - ${month} ${day}, ${year} (${shortId})`;
    const safeFileName = rawName.replace(/[^\p{L}\p{N} \-_.,()']/gu, '').trim();

    const pdfFileName = `${safeFileName}.pdf`;

    await this.storage.replace({
      bucket: StorageBucket.INVOICES,
      fileName: pdfFileName,
      buffer: Buffer.from(response.data),
      mimeType: 'application/pdf',
    });

    return this.prisma.invoice.update({
      where: { id },
      data: { pdfUrl: pdfFileName, status: InvoiceStatus.open },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
  }
}
