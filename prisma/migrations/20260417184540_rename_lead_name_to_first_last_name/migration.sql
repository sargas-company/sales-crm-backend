/*
  Warnings:

  - You are about to drop the column `leadName` on the `Lead` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "leadName",
ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT;
