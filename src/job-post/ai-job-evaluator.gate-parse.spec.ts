import { describe, expect, it } from '@jest/globals';
import {
  GATEKEEPER_TOOL,
  GatekeeperResponseError,
  parseGatekeeperInput,
} from './ai-job-evaluator.service';

describe('GATEKEEPER_TOOL — schema contract', () => {
  it('declares both fit and reason as required with the right shapes', () => {
    const schema = GATEKEEPER_TOOL.input_schema as unknown as {
      required: string[];
      properties: {
        fit: { type: string };
        reason: { type: string; minLength: number; maxLength: number };
      };
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['fit', 'reason']));
    expect(schema.properties.fit.type).toBe('boolean');
    expect(schema.properties.reason.type).toBe('string');
    expect(schema.properties.reason.minLength).toBe(1);
    expect(schema.properties.reason.maxLength).toBe(200);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('parseGatekeeperInput — valid structured output', () => {
  it('accepts fit=true + non-empty reason', () => {
    const r = parseGatekeeperInput({ fit: true, reason: 'Node + Stripe' });
    expect(r).toEqual({ fit: true, reason: 'Node + Stripe' });
  });

  it('accepts fit=false + non-empty reason', () => {
    const r = parseGatekeeperInput({
      fit: false,
      reason: 'Shopify-only build',
    });
    expect(r).toEqual({ fit: false, reason: 'Shopify-only build' });
  });

  it('trims surrounding whitespace in the reason', () => {
    const r = parseGatekeeperInput({ fit: true, reason: '  pass  ' });
    expect(r.reason).toBe('pass');
  });

  it('defensively truncates a long reason (schema caps at 200)', () => {
    const long = 'x'.repeat(500);
    const r = parseGatekeeperInput({ fit: false, reason: long });
    expect(r.reason.length).toBe(200);
  });
});

describe('parseGatekeeperInput — throws GatekeeperResponseError', () => {
  const expectThrows = (input: unknown, matcher: RegExp) => {
    expect(() => parseGatekeeperInput(input)).toThrow(GatekeeperResponseError);
    expect(() => parseGatekeeperInput(input)).toThrow(matcher);
  };

  it('missing reason → throws', () => {
    expectThrows({ fit: true }, /reason is missing or not string/);
  });

  it('empty reason → throws', () => {
    expectThrows({ fit: true, reason: '' }, /reason is missing or not string|reason is empty/);
  });

  it('whitespace-only reason → throws', () => {
    expectThrows({ fit: false, reason: '   ' }, /reason is empty/);
  });

  it('non-string reason → throws', () => {
    expectThrows({ fit: true, reason: 123 }, /reason is missing or not string/);
  });

  it('null reason → throws', () => {
    expectThrows({ fit: false, reason: null }, /reason is missing or not string/);
  });

  it('fit missing → throws', () => {
    expectThrows({ reason: 'ok' }, /fit is missing or not boolean/);
  });

  it('fit as string → throws', () => {
    expectThrows({ fit: 'true', reason: 'ok' }, /fit is missing or not boolean/);
  });

  it('fit as null → throws', () => {
    expectThrows({ fit: null, reason: 'ok' }, /fit is missing or not boolean/);
  });

  it('null input → throws (malformed structured payload)', () => {
    expectThrows(null, /tool input is not an object/);
  });

  it('array input → throws (malformed structured payload)', () => {
    expectThrows([{ fit: true, reason: 'ok' }], /tool input is not an object/);
  });

  it('string input → throws (malformed structured payload)', () => {
    expectThrows('{"fit":true,"reason":"ok"}', /tool input is not an object/);
  });

  it('error carries a sanitised sample of the raw payload', () => {
    try {
      parseGatekeeperInput({ fit: 'oops' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatekeeperResponseError);
      expect((err as GatekeeperResponseError).raw).toContain('oops');
    }
  });
});
