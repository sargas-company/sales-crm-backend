/* eslint-disable no-console */
/**
 * Data-normalization script for stored B2 URLs.
 *
 * Converts legacy rows that persist a permanent B2 URL into the new
 * contract where only the object key is stored. Dry-run by default —
 * pass `--apply` to persist. Rows whose format is not recognised are
 * left alone and reported.
 *
 *   npx ts-node scripts/normalize-file-urls.ts            # dry-run
 *   npx ts-node scripts/normalize-file-urls.ts --apply    # perform
 *
 * Covers:
 *   - `ClientRequest.files[].url`   → drop `url`, keep `fileName` (= key).
 *                                     If `fileName` is empty, recover
 *                                     the key from the URL.
 *   - `Invoice.pdfUrl`              → store only the key.
 *
 * Non-destructive: never writes B2, never deletes rows, only rewrites
 * the two fields above.
 */
import 'dotenv/config';
import { PrismaClient, type Prisma } from '@prisma/client';

function extractKey(url: string): string | null {
  const marker = '/file/';
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  const noQuery = url.split('?')[0];
  const rest = noQuery.slice(idx + marker.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const encoded = rest.slice(slash + 1);
  if (!encoded) return null;
  try {
    return encoded.split('/').map((seg) => decodeURIComponent(seg)).join('/');
  } catch {
    return null;
  }
}

interface StoredFile {
  originalName?: string;
  fileName?: string;
  fileId?: string;
  mimetype?: string;
  size?: number;
  url?: string;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  let crScanned = 0;
  let crNeedsRewrite = 0;
  let crUnknown = 0;
  let crFixed = 0;

  const crs = await prisma.clientRequest.findMany({
    select: { id: true, files: true },
  });
  for (const row of crs) {
    const files = (row.files as unknown as StoredFile[] | null) ?? [];
    crScanned += files.length;
    let dirty = false;
    const next: StoredFile[] = files.map((f) => {
      const copy: StoredFile = { ...f };
      // Case 1: new-shape file (fileName present, no url): nothing to do.
      if (copy.fileName && !copy.url) return copy;
      // Case 2: legacy row with url field — drop it, ensure fileName.
      if (copy.url) {
        if (!copy.fileName) {
          const key = extractKey(copy.url);
          if (!key) {
            crUnknown++;
            return copy;
          }
          copy.fileName = key;
        }
        delete copy.url;
        dirty = true;
        crNeedsRewrite++;
      }
      return copy;
    });
    if (dirty && apply) {
      await prisma.clientRequest.update({
        where: { id: row.id },
        data: { files: next as unknown as Prisma.InputJsonValue },
      });
      crFixed += 1;
    }
  }

  let invScanned = 0;
  let invNeedsRewrite = 0;
  let invUnknown = 0;
  let invFixed = 0;

  const invoices = await prisma.invoice.findMany({
    where: { pdfUrl: { not: null } },
    select: { id: true, pdfUrl: true },
  });
  for (const row of invoices) {
    invScanned++;
    const raw = row.pdfUrl!;
    if (!raw.startsWith('http')) continue;
    const key = extractKey(raw);
    if (!key) {
      invUnknown++;
      continue;
    }
    invNeedsRewrite++;
    if (apply) {
      await prisma.invoice.update({
        where: { id: row.id },
        data: { pdfUrl: key },
      });
      invFixed++;
    }
  }

  await prisma.$disconnect();

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        clientRequests: {
          filesScanned: crScanned,
          filesNeedingRewrite: crNeedsRewrite,
          unknownFormat: crUnknown,
          rowsRewritten: crFixed,
        },
        invoices: {
          pdfsScanned: invScanned,
          pdfsNeedingRewrite: invNeedsRewrite,
          unknownFormat: invUnknown,
          rowsRewritten: invFixed,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[normalize-file-urls] FAILED', err);
  process.exit(1);
});
