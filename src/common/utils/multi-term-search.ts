import { Prisma } from '@prisma/client';

/**
 * Multi-token search filter builder.
 *
 * Splits the raw query by whitespace. Each token must appear in at
 * least one of the given fields (case-insensitive substring); fields
 * are OR'd within a token, tokens are AND'd across each other.
 *
 * Example — query `"Vasya Patel"`, fields `['firstName', 'lastName']`:
 *   AND [
 *     OR [firstName~"Vasya", lastName~"Vasya"],
 *     OR [firstName~"Patel", lastName~"Patel"],
 *   ]
 *
 * Returns `null` when the query is empty — caller spreads nothing.
 * Returns `{ AND: [...] }` otherwise, suitable for spreading into
 * a Prisma `where` object.
 */
export function multiTermSearch<F extends string>(
  rawQuery: string | null | undefined,
  fields: readonly F[],
): { AND: Array<{ OR: Array<Record<F, { contains: string; mode: 'insensitive' }>> }> } | null {
  if (!rawQuery) return null;
  const tokens = rawQuery
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return {
    AND: tokens.map((token) => ({
      OR: fields.map(
        (f) =>
          ({
            [f]: { contains: token, mode: Prisma.QueryMode.insensitive },
          }) as Record<F, { contains: string; mode: 'insensitive' }>,
      ),
    })),
  };
}
