/*
  Warnings:

  - Added the required column `title` to the `Proposal` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Proposal" ALTER COLUMN "title" DROP DEFAULT;
