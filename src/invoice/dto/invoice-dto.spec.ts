import { describe, it, expect } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateInvoiceDto } from './create-invoice.dto';

const baseInvoice = {
  counterpartyId: 'd3f4a5b6-7c89-4d01-9234-567890abcdef',
};

async function errors(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CreateInvoiceDto, payload, {
    enableImplicitConversion: true,
  });
  const errs = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errs.flatMap((e) => {
    const own = Object.values(e.constraints ?? {});
    const nested = (e.children ?? []).flatMap((c) => [
      ...Object.values(c.constraints ?? {}),
      ...(c.children ?? []).flatMap((cc) =>
        Object.values(cc.constraints ?? {}),
      ),
    ]);
    return [...own, ...nested];
  });
}

describe('CreateInvoiceDto cross-field + nested validation', () => {
  it('accepts dueDate equal to date', async () => {
    expect(
      await errors({ ...baseInvoice, date: '2026-05-01', dueDate: '2026-05-01' }),
    ).toEqual([]);
  });

  it('accepts dueDate after date', async () => {
    expect(
      await errors({ ...baseInvoice, date: '2026-05-01', dueDate: '2026-06-01' }),
    ).toEqual([]);
  });

  it('rejects dueDate strictly before date', async () => {
    const msgs = await errors({
      ...baseInvoice,
      date: '2026-05-10',
      dueDate: '2026-05-01',
    });
    expect(msgs).toContain('dueDate must be on or after date');
  });

  it('rejects tax above 100 (percent cap)', async () => {
    const msgs = await errors({ ...baseInvoice, tax: 150 });
    expect(msgs.some((m) => m.includes('tax'))).toBe(true);
  });

  it('accepts tax equal to 100', async () => {
    expect(await errors({ ...baseInvoice, tax: 100 })).toEqual([]);
  });

  it('rejects customFields missing required `name`', async () => {
    const msgs = await errors({
      ...baseInvoice,
      customFields: [{ value: 'v' }],
    });
    expect(msgs.some((m) => m.toLowerCase().includes('name'))).toBe(true);
  });

  it('accepts well-formed customFields', async () => {
    expect(
      await errors({
        ...baseInvoice,
        customFields: [{ name: 'Project', value: 'Website Redesign' }],
      }),
    ).toEqual([]);
  });
});
