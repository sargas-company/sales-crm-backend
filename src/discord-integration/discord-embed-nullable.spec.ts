import { describe, it, expect } from '@jest/globals';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';

const svc = new DiscordEmbedBuilderService();

/**
 * Daily digest no longer carries a per-report author byline — the
 * contributors-snapshot refactor made the row a project-day record,
 * not an authored one. The embed description must therefore be
 * strictly "<hours> hours" with no name interpolation and no
 * accidental `undefined` fallthrough.
 */
describe('daily digest row rendering — no author byline', () => {
  it('renders `<hours> hours` only; no author name is interpolated', () => {
    const embeds = svc.dailyDigestEmbeds({
      reportDate: new Date('2026-10-04T00:00:00Z'),
      rows: [{ projectName: 'Acme', hours: 4 }],
    });
    expect(embeds).toHaveLength(1);
    expect(embeds[0].description).toBe('4 hours');
    expect(JSON.stringify(embeds[0])).not.toContain('undefined');
  });
});
