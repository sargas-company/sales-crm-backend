/**
 * Discord embed chunking + Discord-safe field normalisation.
 *
 * The scheduler sends daily / weekly digests through `chunkEmbeds`,
 * which must:
 *   - split by 10-embed hard cap AND by 6000-char hard cap;
 *   - keep input order; the chunk index is used as part of
 *     `DiscordDelivery.deliveryKey` so order drift would break
 *     per-chunk idempotency;
 *   - never mutate the input;
 *   - truncate every embed field to its Discord-individual limit
 *     before accounting against the 6000-char budget.
 */
import { describe, expect, it } from '@jest/globals';

import {
  DISCORD_EMBED_LIMITS,
  chunkEmbeds,
  embedCharCount,
  normaliseEmbed,
  truncate,
  type DiscordEmbed,
} from './discord-chunking';

const asMessageCharCount = (embeds: readonly DiscordEmbed[]): number =>
  embeds.reduce((sum, e) => sum + embedCharCount(e), 0);

describe('discord-chunking.truncate', () => {
  it('keeps the input when under the cap', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });
  it('ellipsis-terminates at exactly `max` characters when over', () => {
    const result = truncate('a'.repeat(300), 256);
    expect(result).toHaveLength(256);
    expect(result.endsWith('…')).toBe(true);
  });
  it('returns empty when max<=0', () => {
    expect(truncate('abc', 0)).toBe('');
    expect(truncate('abc', -1)).toBe('');
  });
});

describe('discord-chunking.normaliseEmbed', () => {
  it('truncates title / description / field / footer / author to Discord limits', () => {
    const big: DiscordEmbed = {
      title: 'T'.repeat(1000),
      description: 'D'.repeat(5000),
      fields: [
        { name: 'N'.repeat(500), value: 'V'.repeat(5000), inline: true },
      ],
      footer: { text: 'F'.repeat(3000) },
      author: { name: 'A'.repeat(1000) },
    };
    const out = normaliseEmbed(big);
    expect(out.title!.length).toBe(DISCORD_EMBED_LIMITS.TITLE_MAX);
    expect(out.description!.length).toBe(DISCORD_EMBED_LIMITS.DESCRIPTION_MAX);
    expect(out.fields![0].name.length).toBe(DISCORD_EMBED_LIMITS.FIELD_NAME_MAX);
    expect(out.fields![0].value.length).toBe(DISCORD_EMBED_LIMITS.FIELD_VALUE_MAX);
    expect(out.footer!.text!.length).toBe(DISCORD_EMBED_LIMITS.FOOTER_TEXT_MAX);
    expect(out.author!.name!.length).toBe(DISCORD_EMBED_LIMITS.AUTHOR_NAME_MAX);
    expect(out.fields![0].inline).toBe(true);
  });
  it('caps fields at 25 entries', () => {
    const fields = Array.from({ length: 50 }, (_, i) => ({
      name: `n${i}`,
      value: `v${i}`,
    }));
    const out = normaliseEmbed({ fields });
    expect(out.fields!.length).toBe(DISCORD_EMBED_LIMITS.MAX_FIELDS_PER_EMBED);
  });
  it('does NOT mutate the input embed', () => {
    const input: DiscordEmbed = {
      title: 'T'.repeat(500),
      fields: [{ name: 'n', value: 'v' }],
    };
    const inputTitle = input.title;
    const inputFields = input.fields;
    normaliseEmbed(input);
    expect(input.title).toBe(inputTitle);
    expect(input.fields).toBe(inputFields);
  });
});

describe('discord-chunking.embedCharCount', () => {
  it('sums title + description + field.name + field.value + footer.text + author.name', () => {
    const e: DiscordEmbed = {
      title: 'TT',
      description: 'DDD',
      fields: [{ name: 'NN', value: 'VVVV' }],
      footer: { text: 'FFFFF' },
      author: { name: 'AA' },
    };
    expect(embedCharCount(e)).toBe(2 + 3 + 2 + 4 + 5 + 2);
  });
});

describe('discord-chunking.chunkEmbeds — 10-embed cap', () => {
  it('23 embeds → 3 chunks of 10 + 10 + 3', () => {
    const embeds: DiscordEmbed[] = Array.from({ length: 23 }, (_, i) => ({
      title: `t${i}`,
      description: `d${i}`,
    }));
    const chunks = chunkEmbeds(embeds);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 3]);
  });
  it('keeps input order', () => {
    const embeds: DiscordEmbed[] = Array.from({ length: 15 }, (_, i) => ({
      title: `t${i}`,
    }));
    const chunks = chunkEmbeds(embeds);
    const flat = chunks.flat().map((e) => e.title);
    expect(flat).toEqual(embeds.map((e) => e.title));
  });
  it('does NOT mutate input array', () => {
    const embeds: DiscordEmbed[] = Array.from({ length: 5 }, (_, i) => ({
      title: `t${i}`,
    }));
    const original = [...embeds];
    chunkEmbeds(embeds);
    expect(embeds).toEqual(original);
  });
});

describe('discord-chunking.chunkEmbeds — 6000-char cap', () => {
  it('splits before total char count would exceed 6000', () => {
    // Each embed uses ~2200 chars via description (desc max is 4096)
    // → 2 fit per chunk (~4400), 7 embeds → at least 4 chunks.
    const bigDesc = 'D'.repeat(2200);
    const embeds: DiscordEmbed[] = Array.from({ length: 7 }, () => ({
      description: bigDesc,
    }));
    const chunks = chunkEmbeds(embeds);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(asMessageCharCount(c)).toBeLessThanOrEqual(
        DISCORD_EMBED_LIMITS.MAX_TOTAL_CHARS_PER_MESSAGE,
      );
    }
  });
});

describe('discord-chunking.chunkEmbeds — individual Discord limits', () => {
  it('every chunk\'s embeds respect title/description/field limits', () => {
    const embeds: DiscordEmbed[] = Array.from({ length: 12 }, (_, i) => ({
      title: 'T'.repeat(500 + i),
      description: 'D'.repeat(5000),
      fields: [{ name: 'N'.repeat(400), value: 'V'.repeat(2000) }],
    }));
    const chunks = chunkEmbeds(embeds);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
      for (const e of chunk) {
        expect((e.title ?? '').length).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.TITLE_MAX);
        expect((e.description ?? '').length).toBeLessThanOrEqual(
          DISCORD_EMBED_LIMITS.DESCRIPTION_MAX,
        );
        for (const f of e.fields ?? []) {
          expect(f.name.length).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.FIELD_NAME_MAX);
          expect(f.value.length).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.FIELD_VALUE_MAX);
        }
      }
    }
  });
});
