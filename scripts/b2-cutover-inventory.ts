/* eslint-disable no-console */
/**
 * B2 cutover inventory — DB-only dry-run.
 *
 * Walks every DB field that references a B2 object and reports how
 * many keys the production destination bucket should carry. Does NOT
 * touch B2 at all — this is the first phase of a cutover. The second
 * phase (actual copy + checksum compare) is a separate script that
 * only runs after the owner has supplied destination B2 credentials
 * and explicitly asked for `--apply`.
 *
 *   npx ts-node scripts/b2-cutover-inventory.ts
 *
 * The report is printed as JSON so the owner can diff it between
 * local and production. No secrets are read or printed.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

interface InventoryGroup {
  // Logical destination bucket on production. Must match a *_ID /
  // *_NAME env variable set on prod.
  destBucket:
    | 'AVATARS'
    | 'PORTFOLIO'
    | 'INVOICES'
    | 'CLIENT_REQUESTS'
    | 'DB_DUMPS'
    | 'MIXED';
  description: string;
  // Where each key lives in the DB.
  source: string;
  keyCount: number;
  totalBytes?: number;
  sampleKeys: string[];
  notes: string;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const groups: InventoryGroup[] = [];

    // 1. User.avatarKey — AVATARS bucket. Preset avatars (`preset:*`)
    // live on DiceBear and are not objects in B2.
    const avatarsRaw = await prisma.user.findMany({
      where: {
        avatarKey: { not: null },
      },
      select: { avatarKey: true },
    });
    const avatarKeys = avatarsRaw
      .map((u) => u.avatarKey!)
      .filter((k) => !k.startsWith('preset:'));
    groups.push({
      destBucket: 'AVATARS',
      description: 'User-uploaded avatars',
      source: 'User.avatarKey',
      keyCount: avatarKeys.length,
      sampleKeys: avatarKeys.slice(0, 5),
      notes:
        avatarsRaw.length !== avatarKeys.length
          ? `(${avatarsRaw.length - avatarKeys.length} preset avatars skipped — hosted on DiceBear)`
          : 'All real objects.',
    });

    // 2. PortfolioAsset.storageKey — PORTFOLIO bucket.
    const portfolio = await prisma.portfolioAsset.findMany({
      select: { storageKey: true, size: true },
    });
    groups.push({
      destBucket: 'PORTFOLIO',
      description: 'Portfolio case-study images and videos',
      source: 'PortfolioAsset.storageKey',
      keyCount: portfolio.length,
      totalBytes: portfolio.reduce((acc, p) => acc + (p.size ?? 0), 0),
      sampleKeys: portfolio.slice(0, 5).map((p) => p.storageKey),
      notes: 'Every row MUST have a matching B2 object.',
    });

    // 3. Invoice.pdfUrl — INVOICES bucket.
    // Local path shape is `uploads/invoices/<id>.pdf`; on B2 the key
    // uses the same relative path.
    const invoices = await prisma.invoice.findMany({
      where: { pdfUrl: { not: null } },
      select: { pdfUrl: true },
    });
    groups.push({
      destBucket: 'INVOICES',
      description: 'Generated invoice PDFs',
      source: 'Invoice.pdfUrl',
      keyCount: invoices.length,
      sampleKeys: invoices.slice(0, 5).map((i) => i.pdfUrl!),
      notes: 'Keys without a matching PDF object render as blank download.',
    });

    // 4. ClientRequest.files — CLIENT_REQUESTS bucket.
    // JSON column; each entry is an object with `storageKey`.
    const cr = await prisma.clientRequest.findMany({
      where: { files: { not: undefined } },
      select: { id: true, files: true },
    });
    const crKeys: string[] = [];
    let crBytes = 0;
    for (const row of cr) {
      const list = Array.isArray(row.files) ? (row.files as Array<Record<string, unknown>>) : [];
      for (const f of list) {
        if (typeof f.storageKey === 'string') crKeys.push(f.storageKey);
        if (typeof f.size === 'number') crBytes += f.size;
      }
    }
    groups.push({
      destBucket: 'CLIENT_REQUESTS',
      description: 'Public lead-form attachments',
      source: 'ClientRequest.files[].storageKey (JSON)',
      keyCount: crKeys.length,
      totalBytes: crBytes,
      sampleKeys: crKeys.slice(0, 5),
      notes: 'JSON column; one row may hold multiple files.',
    });

    // 5. TimeOff.attachmentKey — same bucket as client-requests
    // historically (file-layer stabilisation migrated them). Flagged
    // MIXED so the owner can confirm which bucket holds them on prod.
    const timeoff = await prisma.timeOff.findMany({
      where: { attachmentKey: { not: null } },
      select: { attachmentKey: true, attachmentSize: true },
    });
    groups.push({
      destBucket: 'MIXED',
      description: 'Time-off doctor notes / supporting docs',
      source: 'TimeOff.attachmentKey',
      keyCount: timeoff.length,
      totalBytes: timeoff.reduce((acc, t) => acc + (t.attachmentSize ?? 0), 0),
      sampleKeys: timeoff.slice(0, 5).map((t) => t.attachmentKey!),
      notes:
        'Confirm with production storage config which bucket holds these; the file-layer migration script `scripts/normalize-file-urls.ts` is the historical source of truth.',
    });

    // 6. BackupRun.{artifactKey, manifestKey} — DB_DUMPS bucket.
    const backups = await prisma.backupRun.findMany({
      where: { OR: [{ artifactKey: { not: null } }, { manifestKey: { not: null } }] },
      select: {
        id: true,
        artifactKey: true,
        manifestKey: true,
        environment: true,
        status: true,
        size: true,
      },
    });
    const backupKeys = backups.flatMap((b) =>
      [b.artifactKey, b.manifestKey].filter((k): k is string => !!k),
    );
    groups.push({
      destBucket: 'DB_DUMPS',
      description: 'Backup artifacts + manifests',
      source: 'BackupRun.{artifactKey, manifestKey}',
      keyCount: backupKeys.length,
      totalBytes: backups.reduce((acc, b) => acc + Number(b.size ?? 0), 0),
      sampleKeys: backupKeys.slice(0, 5),
      notes: `${backups.length} rows (envs: ${[...new Set(backups.map((b) => b.environment))].join(', ') || 'none'}). Pruning this on cutover is a separate decision — do not copy old backups to prod unless the owner asks.`,
    });

    // Final summary.
    const totalKeys = groups.reduce((acc, g) => acc + g.keyCount, 0);
    const totalBytes = groups.reduce((acc, g) => acc + (g.totalBytes ?? 0), 0);

    console.log(
      JSON.stringify(
        {
          mode: 'dry-run (DB only — no B2 traffic)',
          totalKeys,
          totalBytes,
          groups,
          nextSteps: [
            'Compare keyCount with destination bucket object count on production.',
            'Keys present in DB but missing in destination bucket MUST be copied before cutover.',
            'Byte totals from DB are the authoritative upper bound; checksums require a destination-side listing.',
            'The actual copy + checksum pass is a separate script that only runs when the owner provides production B2 credentials and asks for --apply.',
          ],
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error('[b2-cutover-inventory] failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
