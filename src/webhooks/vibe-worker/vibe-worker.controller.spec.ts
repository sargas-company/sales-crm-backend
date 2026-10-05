/**
 * Controller-level regression: calling the handler without any
 * secret headers and without any custom event id still reaches the
 * service and produces a 202-shaped response. If a future change
 * re-attaches a guard, this spec will fail because the service mock
 * would never be invoked.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { VibeWorkerWebhookController } from './vibe-worker.controller';

describe('VibeWorkerWebhookController — no-auth contract', () => {
  it('invokes the service with no event id when neither header nor body carry one', async () => {
    const captureJobPost = jest.fn(
      async (_payload: unknown, _providedEventId: string | null) => ({
        eventId: 'evt-fresh',
        duplicate: false,
      }),
    );
    const ctrl = new VibeWorkerWebhookController(
      { captureJobPost } as never,
    );

    const payload = { from: 'vibe-worker', body: { title: 'test' } };
    const resp = await ctrl.captureJobPost(undefined, payload);

    expect(resp).toEqual({ accepted: true, eventId: 'evt-fresh', duplicate: false });
    expect(captureJobPost).toHaveBeenCalledTimes(1);
    const [passedPayload, passedId] = captureJobPost.mock.calls[0];
    expect(passedPayload).toEqual(payload);
    expect(passedId).toBeNull();
  });

  it('extracts an event id from the body when the header is absent', async () => {
    const captureJobPost = jest.fn(
      async (_payload: unknown, providedEventId: string | null) => ({
        eventId: providedEventId ?? 'fallback',
        duplicate: false,
      }),
    );
    const ctrl = new VibeWorkerWebhookController(
      { captureJobPost } as never,
    );

    const resp = await ctrl.captureJobPost(undefined, { eventId: 'from-body-7' });

    expect(resp.eventId).toBe('from-body-7');
    expect(captureJobPost.mock.calls[0][1]).toBe('from-body-7');
  });

  it('surfaces duplicate=true when the service reports a repeat', async () => {
    const captureJobPost = jest.fn(async () => ({
      eventId: 'evt-dup',
      duplicate: true,
    }));
    const ctrl = new VibeWorkerWebhookController(
      { captureJobPost } as never,
    );
    const resp = await ctrl.captureJobPost(undefined, { ref: 'same' });
    expect(resp).toEqual({ accepted: true, eventId: 'evt-dup', duplicate: true });
  });
});
