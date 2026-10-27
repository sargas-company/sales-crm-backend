-- Widen `size` from INT4 to INT8 so uploads > 2.147 GB fit.
-- PostgreSQL does an in-place column rewrite; existing values are preserved.
ALTER TABLE "FileManagerFile" ALTER COLUMN "size" SET DATA TYPE BIGINT;
ALTER TABLE "FileManagerUploadSession" ALTER COLUMN "size" SET DATA TYPE BIGINT;
