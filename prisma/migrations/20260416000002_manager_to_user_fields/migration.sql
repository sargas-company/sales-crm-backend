-- AlterTable: remove manager from Proposal
ALTER TABLE "Proposal" DROP COLUMN "manager";

-- AlterTable: add firstName and lastName to User
ALTER TABLE "User" ADD COLUMN "firstName" TEXT,
ADD COLUMN "lastName" TEXT;
