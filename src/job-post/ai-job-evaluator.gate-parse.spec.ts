import { describe, expect, it } from '@jest/globals';
import {
  GATEKEEPER_REASON_FALLBACK,
  GatekeeperResponseError,
  parseGatekeeperResponse,
} from './ai-job-evaluator.service';

describe('parseGatekeeperResponse — well-formed responses', () => {
  it('accepts a plain pass', () => {
    const r = parseGatekeeperResponse('{"fit": true, "reason": "Node + Stripe"}');
    expect(r).toEqual({ fit: true, reason: 'Node + Stripe' });
  });

  it('accepts a plain reject', () => {
    const r = parseGatekeeperResponse(
      '{"fit": false, "reason": "Shopify-only build"}',
    );
    expect(r).toEqual({ fit: false, reason: 'Shopify-only build' });
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const r = parseGatekeeperResponse(
      'Here is my answer:\n```json\n{"fit": false, "reason": "WordPress-only"}\n```',
    );
    expect(r).toEqual({ fit: false, reason: 'WordPress-only' });
  });

  it('truncates an overly long reason to 200 chars', () => {
    const longReason = 'x'.repeat(500);
    const r = parseGatekeeperResponse(
      `{"fit": false, "reason": "${longReason}"}`,
    );
    expect(r.reason.length).toBe(200);
  });

  it('trims whitespace in the reason', () => {
    const r = parseGatekeeperResponse('{"fit": true, "reason": "   pass   "}');
    expect(r.reason).toBe('pass');
  });
});

describe('parseGatekeeperResponse — reason-missing fallback (production hotfix)', () => {
  it('{fit:true} with no reason → accepted with fallback', () => {
    const r = parseGatekeeperResponse('{"fit": true}');
    expect(r).toEqual({ fit: true, reason: GATEKEEPER_REASON_FALLBACK });
  });

  it('{fit:false} with no reason → accepted with fallback', () => {
    const r = parseGatekeeperResponse('{"fit": false}');
    expect(r).toEqual({ fit: false, reason: GATEKEEPER_REASON_FALLBACK });
  });

  it('empty / whitespace-only reason → fallback', () => {
    const r = parseGatekeeperResponse('{"fit": true, "reason": "   "}');
    expect(r.reason).toBe(GATEKEEPER_REASON_FALLBACK);
  });

  it('non-string reason → fallback (not thrown)', () => {
    const r = parseGatekeeperResponse('{"fit": true, "reason": 123}');
    expect(r.reason).toBe(GATEKEEPER_REASON_FALLBACK);
    expect(r.fit).toBe(true);
  });

  it('null reason → fallback', () => {
    const r = parseGatekeeperResponse('{"fit": false, "reason": null}');
    expect(r).toEqual({ fit: false, reason: GATEKEEPER_REASON_FALLBACK });
  });
});

describe('parseGatekeeperResponse — still throws on real malformed responses', () => {
  const expectThrows = (raw: string, matcher: RegExp) => {
    expect(() => parseGatekeeperResponse(raw)).toThrow(GatekeeperResponseError);
    expect(() => parseGatekeeperResponse(raw)).toThrow(matcher);
  };

  it('no JSON object at all → throws', () => {
    expectThrows('this is not JSON', /no JSON object found/);
  });

  it('braces present but JSON invalid → throws', () => {
    expectThrows('{"fit": tru}', /invalid JSON/);
  });

  it('fit missing → throws', () => {
    expectThrows('{"reason": "nope"}', /fit is missing or not boolean/);
  });

  it('fit is not boolean (string) → throws', () => {
    expectThrows('{"fit": "true", "reason": "x"}', /fit is missing or not boolean/);
  });

  it('fit is null → throws', () => {
    expectThrows('{"fit": null, "reason": "x"}', /fit is missing or not boolean/);
  });

  it('error carries a sanitised sample of the raw response', () => {
    try {
      parseGatekeeperResponse('completely-off-the-rails');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatekeeperResponseError);
      expect((err as GatekeeperResponseError).raw).toBe('completely-off-the-rails');
    }
  });
});
