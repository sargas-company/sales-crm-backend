-- Additive: nullable B2 key of a 256×256 WebP preview for image
-- files. NULL for non-image rows, generation failures, and
-- pre-backfill legacy rows (scripts/backfill-file-manager-thumbnails
-- fills those in once).
ALTER TABLE "FileManagerFile" ADD COLUMN "thumbnailKey" TEXT;
