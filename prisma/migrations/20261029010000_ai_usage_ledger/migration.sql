-- Durable audit of every Anthropic Messages API call we initiate.
-- Decoupled from the business entity (no FK) so JobPost deletion
-- never erases spend history. `estimatedCostUsd` is stamped at
-- write time against the price table pinned by `pricingVersion`,
-- so later price changes do not retroactively alter totals.
CREATE TABLE "AiUsageLedger" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "requestId" TEXT,
    "relatedJobPostId" TEXT,
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL,
    "pricingVersion" TEXT NOT NULL,

    CONSTRAINT "AiUsageLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiUsageLedger_createdAt_idx" ON "AiUsageLedger"("createdAt");
CREATE INDEX "AiUsageLedger_operation_createdAt_idx" ON "AiUsageLedger"("operation", "createdAt");
CREATE INDEX "AiUsageLedger_model_createdAt_idx" ON "AiUsageLedger"("model", "createdAt");
