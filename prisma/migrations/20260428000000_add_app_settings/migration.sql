-- CreateEnum
CREATE TYPE "SettingType" AS ENUM ('string', 'number', 'boolean', 'json');

-- CreateEnum
CREATE TYPE "SettingUIType" AS ENUM ('input', 'textarea', 'select', 'toggle', 'password');

-- CreateTable
CREATE TABLE "SettingSection" (
    "id"        TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "order"     INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettingSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id"               TEXT NOT NULL,
    "key"              TEXT NOT NULL,
    "sectionId"        TEXT NOT NULL,
    "type"             "SettingType" NOT NULL,
    "title"            TEXT NOT NULL,
    "description"      TEXT,
    "isSecret"         BOOLEAN NOT NULL DEFAULT false,
    "isRequired"       BOOLEAN NOT NULL DEFAULT false,
    "isActive"         BOOLEAN NOT NULL DEFAULT true,
    "order"            INTEGER NOT NULL DEFAULT 0,
    "defaultValue"     JSONB,
    "uiType"           "SettingUIType" NOT NULL,
    "options"          JSONB,
    "validationSchema" JSONB,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingValue" (
    "id"        TEXT NOT NULL,
    "settingId" TEXT NOT NULL,
    "value"     JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettingValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SettingSection_key_key" ON "SettingSection"("key");
CREATE INDEX "SettingSection_order_idx" ON "SettingSection"("order");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");
CREATE INDEX "Setting_sectionId_idx" ON "Setting"("sectionId");
CREATE INDEX "Setting_isActive_idx" ON "Setting"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SettingValue_settingId_key" ON "SettingValue"("settingId");

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "SettingSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettingValue" ADD CONSTRAINT "SettingValue_settingId_fkey"
    FOREIGN KEY ("settingId") REFERENCES "Setting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
