import { describe, it, expect } from '@jest/globals';
import { DiscordSchedulersService } from './discord-schedulers.service';

// Catch-up semantics live in `timeReached` (private) and the way
// `tick()` consults the delivery row. Here we drive the private
// helper directly through a tiny subclass.
class TestScheduler extends DiscordSchedulersService {
  constructor() {
    super(null as never, null as never, null as never, null as never);
  }
  reached(now: string, sched: string): boolean {
    return (this as unknown as { timeReached: (a: string, b: string) => boolean })
      .timeReached(now, sched);
  }
}

describe('scheduler catch-up gate', () => {
  const s = new TestScheduler();

  it('09:00 scheduled fires at 09:00', () => {
    expect(s.reached('09:00', '09:00')).toBe(true);
  });

  it('09:00 scheduled still fires at 09:47 (catch-up after downtime)', () => {
    expect(s.reached('09:47', '09:00')).toBe(true);
  });

  it('09:00 scheduled does not fire at 08:59', () => {
    expect(s.reached('08:59', '09:00')).toBe(false);
  });

  it('18:00 reminder fires at 18:35 — late, still useful', () => {
    expect(s.reached('18:35', '18:00')).toBe(true);
  });
});
