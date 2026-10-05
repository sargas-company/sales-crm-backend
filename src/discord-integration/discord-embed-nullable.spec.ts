import { describe, it, expect } from '@jest/globals';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';

const svc = new DiscordEmbedBuilderService();

describe('daily digest row rendering — null employee', () => {
  it('falls back to discordUsername when employee is null', () => {
    const embeds = svc.dailyDigestEmbeds({
      reportDate: new Date('2026-10-04T00:00:00Z'),
      rows: [
        { projectName: 'Acme', authorName: 'alice-discord', hours: 4 },
      ],
    });
    expect(embeds).toHaveLength(1);
    expect(embeds[0].description).toContain('alice-discord');
    // Does not interpolate `undefined undefined`.
    expect(JSON.stringify(embeds[0])).not.toContain('undefined');
  });
});
