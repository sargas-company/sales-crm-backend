/**
 * Discord embed limits + chunking.
 *
 * Discord enforces hard limits per message:
 *   - max 10 embeds per message
 *   - max 6000 characters across all embeds (title + description +
 *     every field.name + field.value + footer.text + author.name,
 *     summed over all embeds)
 *   - per embed: title ≤ 256, description ≤ 4096
 *   - per field: name ≤ 256, value ≤ 1024, max 25 fields per embed
 *   - footer.text ≤ 2048, author.name ≤ 256
 *
 * This module provides:
 *   1. `normaliseEmbed(embed)` — returns a copy with every oversized
 *      string truncated to its limit (ellipsis-terminated); the input
 *      is NEVER mutated.
 *   2. `embedCharCount(embed)` — returns the character count under the
 *      Discord 6000-char budget rule.
 *   3. `chunkEmbeds(embeds, { maxEmbeds, maxChars })` — splits a stable-
 *      ordered embed list into Discord-safe chunks, each with ≤10
 *      embeds and ≤6000 characters. Preserves input order; input array
 *      is NEVER mutated.
 *
 * Chunking is deterministic: ordering of the input decides ordering
 * of the output, so idempotency keys like `jobType:period:chunk:N`
 * refer to the same slice across retries. Callers are expected to
 * sort the source rows with a stable tie-breaker (e.g. `id`) BEFORE
 * passing them in.
 */

export const DISCORD_EMBED_LIMITS = {
  MAX_EMBEDS_PER_MESSAGE: 10,
  MAX_TOTAL_CHARS_PER_MESSAGE: 6000,
  TITLE_MAX: 256,
  DESCRIPTION_MAX: 4096,
  FIELD_NAME_MAX: 256,
  FIELD_VALUE_MAX: 1024,
  FOOTER_TEXT_MAX: 2048,
  AUTHOR_NAME_MAX: 256,
  MAX_FIELDS_PER_EMBED: 25,
} as const;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  url?: string;
  fields?: DiscordEmbedField[];
  footer?: { text?: string; icon_url?: string };
  author?: { name?: string; icon_url?: string; url?: string };
  [k: string]: unknown;
}

/**
 * Truncate `s` to `max` characters without mutating the input string
 * (strings are immutable in JS anyway, but the contract matters).
 * When truncation happens, the final character is replaced with an
 * ellipsis so the output stays at exactly `max` characters.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Return a copy of `embed` with every oversized string truncated to
 * its Discord limit and `fields` capped at 25 entries. The input
 * object is not touched; nested arrays/objects are shallow-cloned.
 */
export function normaliseEmbed(embed: DiscordEmbed): DiscordEmbed {
  const out: DiscordEmbed = { ...embed };
  if (typeof out.title === 'string') {
    out.title = truncate(out.title, DISCORD_EMBED_LIMITS.TITLE_MAX);
  }
  if (typeof out.description === 'string') {
    out.description = truncate(
      out.description,
      DISCORD_EMBED_LIMITS.DESCRIPTION_MAX,
    );
  }
  if (Array.isArray(out.fields)) {
    out.fields = out.fields
      .slice(0, DISCORD_EMBED_LIMITS.MAX_FIELDS_PER_EMBED)
      .map((f) => ({
        name: truncate(f.name ?? '', DISCORD_EMBED_LIMITS.FIELD_NAME_MAX),
        value: truncate(f.value ?? '', DISCORD_EMBED_LIMITS.FIELD_VALUE_MAX),
        ...(typeof f.inline === 'boolean' ? { inline: f.inline } : {}),
      }));
  }
  if (out.footer && typeof out.footer.text === 'string') {
    out.footer = {
      ...out.footer,
      text: truncate(out.footer.text, DISCORD_EMBED_LIMITS.FOOTER_TEXT_MAX),
    };
  }
  if (out.author && typeof out.author.name === 'string') {
    out.author = {
      ...out.author,
      name: truncate(out.author.name, DISCORD_EMBED_LIMITS.AUTHOR_NAME_MAX),
    };
  }
  return out;
}

/**
 * Character count of a single embed under Discord's 6000-char budget
 * rule. Counts the strings Discord itself counts: title, description,
 * every field.name and field.value, footer.text, author.name. Does
 * not count URLs or colors.
 */
export function embedCharCount(embed: DiscordEmbed): number {
  let n = 0;
  if (typeof embed.title === 'string') n += embed.title.length;
  if (typeof embed.description === 'string') n += embed.description.length;
  if (Array.isArray(embed.fields)) {
    for (const f of embed.fields) {
      if (typeof f.name === 'string') n += f.name.length;
      if (typeof f.value === 'string') n += f.value.length;
    }
  }
  if (embed.footer && typeof embed.footer.text === 'string') {
    n += embed.footer.text.length;
  }
  if (embed.author && typeof embed.author.name === 'string') {
    n += embed.author.name.length;
  }
  return n;
}

export interface ChunkOptions {
  maxEmbeds?: number;
  maxChars?: number;
}

/**
 * Deterministically split `embeds` into Discord-safe chunks under the
 * two caps:
 *   - at most `maxEmbeds` (default 10) per chunk;
 *   - at most `maxChars` (default 6000) summed `embedCharCount` per
 *     chunk.
 *
 * Every embed is `normaliseEmbed`-passed on the way in, so output
 * chunks are safe to send directly to `bot.postMessage`. Order is
 * preserved: embeds[i] from input lands in the earliest chunk that
 * still has room, never reordered relative to its neighbours. Input
 * array is not mutated.
 *
 * Edge case: a single embed whose character count exceeds `maxChars`
 * (shouldn't happen after `normaliseEmbed`, since the per-field caps
 * already sum below 6000, but defensive) still gets its own chunk —
 * splitting one embed across messages is nonsensical.
 */
export function chunkEmbeds(
  embeds: readonly DiscordEmbed[],
  options: ChunkOptions = {},
): DiscordEmbed[][] {
  const maxEmbeds = options.maxEmbeds ?? DISCORD_EMBED_LIMITS.MAX_EMBEDS_PER_MESSAGE;
  const maxChars = options.maxChars ?? DISCORD_EMBED_LIMITS.MAX_TOTAL_CHARS_PER_MESSAGE;

  const chunks: DiscordEmbed[][] = [];
  let current: DiscordEmbed[] = [];
  let currentChars = 0;

  for (const raw of embeds) {
    const safe = normaliseEmbed(raw);
    const cost = embedCharCount(safe);
    const wouldOverflow =
      current.length >= maxEmbeds || currentChars + cost > maxChars;
    if (current.length > 0 && wouldOverflow) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(safe);
    currentChars += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
