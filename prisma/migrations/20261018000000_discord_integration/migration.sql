-- Discord integration schema additions.
-- Everything here is additive and nullable so legacy rows survive.

ALTER TABLE "Project" ADD COLUMN "discordChannelId" TEXT;
CREATE UNIQUE INDEX "Project_discordChannelId_key" ON "Project"("discordChannelId");

ALTER TABLE "Employee" ADD COLUMN "dateOfBirth" DATE;
ALTER TABLE "Employee" ADD COLUMN "discordUserId" TEXT;
CREATE UNIQUE INDEX "Employee_discordUserId_key" ON "Employee"("discordUserId");

CREATE TYPE "DiscordProfileName" AS ENUM ('TEST', 'PRODUCTION');

CREATE TABLE "DiscordProfile" (
    "id" TEXT NOT NULL,
    "name" "DiscordProfileName" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "guildId" TEXT,
    "pmsChannelId" TEXT,
    "generalChannelId" TEXT,
    "opsChannelId" TEXT,
    "managerRoleId" TEXT,
    "reportsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "birthdaysEnabled" BOOLEAN NOT NULL DEFAULT true,
    "absencesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "weeklyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cutoffHour" INTEGER NOT NULL DEFAULT 10,
    "reminderAt" TEXT NOT NULL DEFAULT '18:00',
    "dailyDigestAt" TEXT NOT NULL DEFAULT '19:00',
    "weeklyDigestDay" INTEGER NOT NULL DEFAULT 1,
    "weeklyDigestAt" TEXT NOT NULL DEFAULT '09:00',
    "birthdayAt" TEXT NOT NULL DEFAULT '09:00',
    "absencesAt" TEXT NOT NULL DEFAULT '09:00',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Kyiv',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastVerificationError" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscordProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscordProfile_name_key" ON "DiscordProfile"("name");
CREATE INDEX "DiscordProfile_active_idx" ON "DiscordProfile"("active");

CREATE TYPE "DiscordJobType" AS ENUM (
    'REMINDER_18',
    'DAILY_DIGEST_19',
    'WEEKLY_DIGEST',
    'BIRTHDAY',
    'ABSENCES',
    'LATE_REPORT',
    'TEST'
);

CREATE TYPE "DiscordDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "DiscordDelivery" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "jobType" "DiscordJobType" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" "DiscordDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscordDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DiscordDelivery_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "DiscordProfile"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "DiscordDelivery_deliveryKey_key" ON "DiscordDelivery"("deliveryKey");
CREATE INDEX "DiscordDelivery_jobType_periodKey_idx" ON "DiscordDelivery"("jobType", "periodKey");

-- Seed the two profiles so operators have shells to fill in.
INSERT INTO "DiscordProfile" ("id", "name", "updatedAt") VALUES
    (gen_random_uuid(), 'TEST', NOW()),
    (gen_random_uuid(), 'PRODUCTION', NOW());

-- New permissions. Mirror of the pattern used by 20261017000000.
INSERT INTO "Permission" (id, module, action, key, label, "createdAt") VALUES
    (gen_random_uuid(), 'discord_integration', 'view',               'discord_integration:view',               'View Discord integration settings',                      NOW()),
    (gen_random_uuid(), 'discord_integration', 'configure',          'discord_integration:configure',          'Edit Discord integration profiles',                      NOW()),
    (gen_random_uuid(), 'discord_integration', 'send_test',          'discord_integration:send_test',          'Fire Discord verify/preview/test deliveries',            NOW()),
    (gen_random_uuid(), 'discord_integration', 'activate_profile',   'discord_integration:activate_profile',   'Switch the active Discord profile (TEST ⇄ PRODUCTION)',  NOW())
ON CONFLICT (key) DO NOTHING;
