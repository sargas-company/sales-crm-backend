/**
 * Local-only demo seeder — inserts (or updates) a ClientRequest row
 * with varied file metadata so the preview UI can be visually tested
 * across mime types without actually uploading anything to B2.
 *
 * The `files` JSON only carries METADATA — no bytes are produced.
 * Clicking download in the UI will 404 against B2 (bucket has no
 * matching objects), which is expected: the point is purely visual
 * verification of the AttachmentsSection rendering.
 *
 * Guard: refuses to run unless `APP_ENV=local` AND the resolved
 * database host matches the local-dev convention. Never run on prod.
 *
 * Usage:
 *   cd sales-crm-backend && npx tsx scripts/seed-client-request-files-demo.ts
 */
import { PrismaClient } from '@prisma/client';

function assertLocal(): void {
  if (process.env.APP_ENV !== 'local') {
    throw new Error(
      `Refusing to run: APP_ENV must be "local" (got "${process.env.APP_ENV ?? ''}"). This script is dev-only.`,
    );
  }
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1|\[::1\]):(5432|5433)\//.test(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL does not look local. Expected host localhost/127.0.0.1 and port 5432 or 5433.`,
    );
  }
}

const DEMO_FILES = [
  {
    originalName: 'brief.pdf',
    fileName: 'client-requests/demo-abc/brief.pdf',
    mimetype: 'application/pdf',
    size: 847_123,
  },
  {
    originalName: 'wireframes.pdf',
    fileName: 'client-requests/demo-abc/wireframes.pdf',
    mimetype: 'application/pdf',
    size: 2_413_990,
  },
  {
    originalName: 'logo-mockup.jpg',
    fileName: 'client-requests/demo-abc/logo-mockup.jpg',
    mimetype: 'image/jpeg',
    size: 384_221,
  },
  {
    originalName: 'reference-shots.png',
    fileName: 'client-requests/demo-abc/reference-shots.png',
    mimetype: 'image/png',
    size: 1_240_880,
  },
  {
    originalName: 'contract-draft.docx',
    fileName: 'client-requests/demo-abc/contract-draft.docx',
    mimetype:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 54_112,
  },
  {
    originalName: 'budget-estimate.xlsx',
    fileName: 'client-requests/demo-abc/budget-estimate.xlsx',
    mimetype:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 23_776,
  },
  {
    originalName: 'notes.txt',
    fileName: 'client-requests/demo-abc/notes.txt',
    mimetype: 'text/plain',
    size: 1_892,
  },
  {
    originalName: 'archive.zip',
    fileName: 'client-requests/demo-abc/archive.zip',
    mimetype: 'application/zip',
    size: 15_872_344,
  },
];

async function main(): Promise<void> {
  assertLocal();

  const prisma = new PrismaClient();
  try {
    // Prefer an existing on_review request so the demo lives on
    // whichever one the owner is currently browsing; otherwise create
    // a fresh one.
    let target = await prisma.clientRequest.findFirst({
      where: { status: 'on_review' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true },
    });

    if (!target) {
      const created = await prisma.clientRequest.create({
        data: {
          name: 'Demo Contact (seeded)',
          company: 'Acme Design Studio',
          email: 'demo@example.com',
          phone: '14155550123',
          phoneCountry: 'us',
          message:
            'Seeded demo request to preview attached-file rendering across mime types. Nothing in B2 — download will 404 by design.',
          services: ['design', 'development'],
          status: 'on_review',
          files: DEMO_FILES,
        },
        select: { id: true, name: true },
      });
      target = created;
      console.log(`Created new demo ClientRequest ${created.id} (${created.name})`);
    } else {
      await prisma.clientRequest.update({
        where: { id: target.id },
        data: { files: DEMO_FILES },
      });
      console.log(
        `Updated existing ClientRequest ${target.id} (${target.name}) with ${DEMO_FILES.length} demo files.`,
      );
    }

    console.log(`\nOpen the preview page to see the result:`);
    console.log(`  http://localhost:5173/website-requests/${target.id}`);
    console.log(`\nFile types in the demo:`);
    for (const f of DEMO_FILES) {
      console.log(`  - ${f.originalName}  (${f.mimetype}, ${f.size} bytes)`);
    }
    console.log(
      `\nNote: downloads will 404 — the files JSON carries metadata only, nothing in B2.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
