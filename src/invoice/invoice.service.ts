import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import {
  AuditResult,
  AuditSeverity,
  InvoiceStatus,
  Prisma,
} from '@prisma/client';

import { AuthUser, scopePolicy } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { safeDiff } from '../audit-event/audit-sanitizer';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
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
    private readonly audit: AuditEventService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Resolve the current invoice defaults from Settings. Used only
   * when a new invoice is being drafted and the caller did not
   * explicitly override. Existing invoices keep their snapshot.
   */
  async getInvoiceDefaults() {
    const [currency, paymentTermsDays, numberPrefix, note, instructions] =
      await Promise.all([
        this.settings.getStringForKey(SK.INVOICE_DEFAULT_CURRENCY, 'USD'),
        this.settings.getNumberForKey(
          SK.INVOICE_DEFAULT_PAYMENT_TERMS_DAYS,
          14,
        ),
        this.settings.getStringForKey(SK.INVOICE_NUMBER_PREFIX, 'INV-'),
        this.settings.getStringForKey(SK.INVOICE_DEFAULT_NOTE, ''),
        this.settings.getStringForKey(
          SK.INVOICE_PAYMENT_INSTRUCTIONS,
          '',
        ),
      ]);
    return {
      currency,
      paymentTermsDays,
      numberPrefix,
      note,
      instructions,
    };
  }

  private invoiceLabel(invoice: {
    number: string | null;
    counterparty: { firstName: string | null; lastName: string | null };
  }) {
    const name =
      `${invoice.counterparty.firstName ?? ''} ${invoice.counterparty.lastName ?? ''}`.trim();
    const num = invoice.number ? `#${invoice.number}` : '';
    return [num, name].filter(Boolean).join(' · ') || 'Invoice';
  }

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

    // Fill in defaults from Settings when the caller did not pass
    // them. Existing invoices are never rewritten after a Settings
    // change — the data is baked in at create time.
    const defaults = await this.getInvoiceDefaults();
    const resolvedCurrency = invoiceData.currency ?? defaults.currency;
    const resolvedNote =
      invoiceData.notes !== undefined && invoiceData.notes !== null
        ? invoiceData.notes
        : defaults.note || undefined;

    const created = await this.prisma.invoice.create({
      data: {
        ...invoiceData,
        currency: resolvedCurrency,
        notes: resolvedNote,
        date: invoiceData.date ? new Date(invoiceData.date) : undefined,
        dueDate: invoiceData.dueDate
          ? new Date(invoiceData.dueDate)
          : undefined,
        labels: invoiceData.labels ?? {},
        // Serialise class-validator DTO instances to plain objects for
        // Prisma's `InputJsonValue`. The wire shape stays `{ name, value }`.
        customFields: (invoiceData.customFields ?? []).map((c) => ({
          name: c.name,
          value: c.value,
        })),
        lineItems: lineItems?.length ? { create: lineItems } : undefined,
      },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
    await this.audit.recordSafe({
      actorUserId: user.id,
      // actorEmail resolved at read-time from User join
      domain: 'FINANCE',
      action: 'invoice.create',
      targetType: 'Invoice',
      targetId: created.id,
      targetLabel: this.invoiceLabel(created),
      targetHref: `/invoices/edit/${created.id}`,
      result: AuditResult.SUCCESS,
      metadata: {
        number: created.number,
        currency: created.currency,
        status: created.status,
      },
    });
    return created;
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

    const updated = await this.prisma.$transaction(async (tx) => {
      if (lineItems !== undefined) {
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
      }

      // Peel `customFields` off so we can emit it as plain JSON for
      // Prisma. Shape on the wire is unchanged.
      const { customFields, ...rest } = invoiceData;
      return tx.invoice.update({
        where: { id },
        data: {
          ...rest,
          date: invoiceData.date ? new Date(invoiceData.date) : undefined,
          dueDate: invoiceData.dueDate
            ? new Date(invoiceData.dueDate)
            : undefined,
          ...(customFields !== undefined
            ? {
                customFields: customFields.map((c) => ({
                  name: c.name,
                  value: c.value,
                })),
              }
            : {}),
          lineItems: lineItems?.length ? { create: lineItems } : undefined,
        },
        include: {
          lineItems: { orderBy: { sortOrder: 'asc' } },
          counterparty: true,
        },
      });
    });

    // Audit — compute a sanitized diff of the money-visible fields.
    const changes = safeDiff(
      {
        number: existing.number,
        status: existing.status,
        currency: existing.currency,
        date: existing.date?.toISOString() ?? null,
        dueDate: existing.dueDate?.toISOString() ?? null,
        amountPaid: existing.amountPaid?.toString() ?? null,
        tax: existing.tax?.toString() ?? null,
        discounts: existing.discounts?.toString() ?? null,
        shipping: existing.shipping?.toString() ?? null,
      },
      {
        number: updated.number,
        status: updated.status,
        currency: updated.currency,
        date: updated.date?.toISOString() ?? null,
        dueDate: updated.dueDate?.toISOString() ?? null,
        amountPaid: updated.amountPaid?.toString() ?? null,
        tax: updated.tax?.toString() ?? null,
        discounts: updated.discounts?.toString() ?? null,
        shipping: updated.shipping?.toString() ?? null,
      },
    );
    const action =
      existing.status !== updated.status
        ? 'invoice.status.change'
        : 'invoice.update';
    await this.audit.recordSafe({
      actorUserId: user.id,
      // actorEmail resolved at read-time from User join
      domain: 'FINANCE',
      action,
      targetType: 'Invoice',
      targetId: updated.id,
      targetLabel: this.invoiceLabel(updated),
      targetHref: `/invoices/edit/${updated.id}`,
      result: AuditResult.SUCCESS,
      severity:
        existing.status !== updated.status
          ? AuditSeverity.WARNING
          : AuditSeverity.INFO,
      changes: changes ?? null,
    });
    return updated;
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
      // Legacy rows stored a full URL; new rows store the key alone.
      // `extractKeyFromLegacyUrl` returns null for anything that is
      // not a `/file/<bucket>/<key>` URL, which is also the shape
      // produced for plain keys, so we fall through on null.
      const fileName = invoice.pdfUrl.startsWith('http')
        ? this.storage.extractKeyFromLegacyUrl(invoice.pdfUrl) ?? invoice.pdfUrl
        : invoice.pdfUrl;
      await this.storage.deleteByName(StorageBucket.INVOICES, fileName);
    }

    const deleted = await this.prisma.invoice.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId: user.id,
      // actorEmail resolved at read-time from User join
      domain: 'FINANCE',
      action: 'invoice.delete',
      targetType: 'Invoice',
      targetId: id,
      targetLabel: this.invoiceLabel(invoice),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
      metadata: {
        number: invoice.number,
        currency: invoice.currency,
        status: invoice.status,
      },
    });
    return deleted;
  }

  async getPdfDownloadUrl(id: string, user: AuthUser): Promise<string> {
    const invoice = await this.findOne(id, user);
    if (!invoice.pdfUrl) throw new NotFoundException('Invoice PDF has not been generated yet');
    // pdfUrl can be a full URL (old records) or plain filename (new records)
    const fileName = invoice.pdfUrl.startsWith('http')
      ? this.storage.extractKeyFromLegacyUrl(invoice.pdfUrl) ?? invoice.pdfUrl
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

    const generated = await this.prisma.invoice.update({
      where: { id },
      data: { pdfUrl: pdfFileName, status: InvoiceStatus.open },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        counterparty: true,
      },
    });
    await this.audit.recordSafe({
      actorUserId: user.id,
      // actorEmail resolved at read-time from User join
      domain: 'FINANCE',
      action: 'invoice.pdf.generate',
      targetType: 'Invoice',
      targetId: id,
      targetLabel: this.invoiceLabel(generated),
      targetHref: `/invoices/edit/${id}`,
      result: AuditResult.SUCCESS,
      metadata: {
        number: generated.number,
        file: pdfFileName,
      },
    });
    return generated;
  }
}
