-- CreateEnum
CREATE TYPE "CallReminderType" AS ENUM ('min60', 'min10');

-- CreateTable
CREATE TABLE "CallReminderSent" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "type" "CallReminderType" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallReminderSent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallReminderSent_callId_type_key" ON "CallReminderSent"("callId", "type");

-- AddForeignKey
ALTER TABLE "CallReminderSent" ADD CONSTRAINT "CallReminderSent_callId_fkey" FOREIGN KEY ("callId") REFERENCES "ClientCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;
