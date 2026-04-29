import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { InvoiceStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StorageBucket, StorageService } from '../storage';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';

@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  async create(dto: CreateInvoiceDto) {
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

  async findAll(page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { counterparty: true },
      }),
      this.prisma.invoice.count(),
    ]);

    return { data, total };
  }

  async findOne(id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async update(id: string, dto: UpdateInvoiceDto) {
    const existing = await this.findOne(id);

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

  async remove(id: string) {
    const invoice = await this.findOne(id);

    if (invoice.pdfUrl) {
      const fileName = invoice.pdfUrl.startsWith('http')
        ? decodeURIComponent(invoice.pdfUrl.split('/').pop()!)
        : invoice.pdfUrl;
      await this.storage.deleteByName(StorageBucket.INVOICES, fileName);
    }

    return this.prisma.invoice.delete({ where: { id } });
  }

  async getPdfDownloadUrl(id: string): Promise<string> {
    const invoice = await this.findOne(id);
    if (!invoice.pdfUrl) throw new NotFoundException('Invoice PDF has not been generated yet');
    // pdfUrl can be a full URL (old records) or plain filename (new records)
    const fileName = invoice.pdfUrl.startsWith('http')
      ? decodeURIComponent(invoice.pdfUrl.split('/').pop()!)
      : invoice.pdfUrl;
    return this.storage.getDownloadUrl(StorageBucket.INVOICES, fileName);
  }

  async generate(id: string) {
    const invoice = await this.findOne(id);

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
