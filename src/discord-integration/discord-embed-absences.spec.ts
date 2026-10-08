/**
 * Vacation / Sick-leave absence cards share the two legacy report
 * hexes (LEGACY_BLUE / LEGACY_RED). Everything else about the
 * absences surface — ordering, titles, mentions, scheduling, how
 * off-days are enumerated — is NOT this spec's business.
 */
import { describe, expect, it } from '@jest/globals';

import {
  DiscordEmbedBuilderService,
  LEGACY_BLUE,
  LEGACY_RED,
} from './discord-embed-builder.service';

const svc = new DiscordEmbedBuilderService();
const endDate = new Date('2026-11-15T00:00:00Z');

describe('absencesEmbeds — legacy palette', () => {
  it('VACATION card is LEGACY_BLUE', () => {
    const [e] = svc.absencesEmbeds([
      {
        type: 'VACATION',
        firstName: 'Alice',
        lastName: 'Example',
        endDate,
      },
    ]);
    expect(e.color).toBe(LEGACY_BLUE);
  });

  it('SICK_LEAVE card is LEGACY_RED', () => {
    const [e] = svc.absencesEmbeds([
      {
        type: 'SICK_LEAVE',
        firstName: 'Bob',
        lastName: 'Example',
        endDate,
      },
    ]);
    expect(e.color).toBe(LEGACY_RED);
  });

  it('other off-day types keep a neutral grey (not forced to legacy palette)', () => {
    const [e] = svc.absencesEmbeds([
      {
        type: 'UNPAID',
        firstName: 'Carol',
        lastName: 'Example',
        endDate,
      },
    ]);
    expect(e.color).toBe(0x95a5a6);
  });
});
