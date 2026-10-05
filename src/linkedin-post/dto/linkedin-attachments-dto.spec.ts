import { describe, it, expect } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateLinkedInPostDto } from './create-linkedin-post.dto';

const baseline = {
  internalTitle: 't',
  accountId: 'd3f4a5b6-7c89-4d01-9234-567890abcdef',
  body: 'b',
};

async function errors(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CreateLinkedInPostDto, payload, {
    enableImplicitConversion: true,
  });
  const errs = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errs.flatMap((e) => {
    const own = Object.values(e.constraints ?? {});
    const nested = (e.children ?? []).flatMap((c) =>
      [
        ...Object.values(c.constraints ?? {}),
        ...(c.children ?? []).flatMap((cc) =>
          Object.values(cc.constraints ?? {}),
        ),
      ],
    );
    return [...own, ...nested];
  });
}

describe('CreateLinkedInPostDto attachments nested validation', () => {
  it('accepts a valid attachment with url only', async () => {
    expect(
      await errors({
        ...baseline,
        attachments: [{ url: 'https://example.com/x.png' }],
      }),
    ).toEqual([]);
  });

  it('rejects an attachment without url', async () => {
    const msgs = await errors({
      ...baseline,
      attachments: [{ name: 'no url' }],
    });
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('rejects a non-URL in attachment.url', async () => {
    const msgs = await errors({
      ...baseline,
      attachments: [{ url: 'not a url' }],
    });
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('rejects more than ArrayMaxSize(20) attachments', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      url: `https://example.com/${i}.png`,
    }));
    const msgs = await errors({ ...baseline, attachments: many });
    expect(msgs.some((m) => m.toLowerCase().includes('20'))).toBe(true);
  });
});
