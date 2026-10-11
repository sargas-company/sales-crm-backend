-- Free-form file uploads attached to a Lead or Client. Exactly one
-- of `leadId` / `clientId` is set per row; a DB CHECK enforces this
-- so a buggy writer can't produce an orphan or double-owned row.

CREATE TABLE "Attachment" (
	"id"           TEXT     NOT NULL PRIMARY KEY,
	"leadId"       TEXT,
	"clientId"     TEXT,
	"originalName" TEXT     NOT NULL,
	"storageKey"   TEXT     NOT NULL,
	"mimeType"     TEXT     NOT NULL,
	"size"         INTEGER  NOT NULL,
	"uploadedById" TEXT,
	"createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

	CONSTRAINT "Attachment_leadId_fkey"
		FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
		ON DELETE CASCADE ON UPDATE CASCADE,
	CONSTRAINT "Attachment_clientId_fkey"
		FOREIGN KEY ("clientId") REFERENCES "Client"("id")
		ON DELETE CASCADE ON UPDATE CASCADE,
	CONSTRAINT "Attachment_uploadedById_fkey"
		FOREIGN KEY ("uploadedById") REFERENCES "User"("id")
		ON DELETE SET NULL ON UPDATE CASCADE,

	CONSTRAINT "Attachment_exactly_one_owner" CHECK (
		(("leadId" IS NOT NULL)::int + ("clientId" IS NOT NULL)::int) = 1
	)
);

CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");
CREATE INDEX        "Attachment_leadId_idx"      ON "Attachment"("leadId");
CREATE INDEX        "Attachment_clientId_idx"    ON "Attachment"("clientId");
CREATE INDEX        "Attachment_createdAt_idx"   ON "Attachment"("createdAt");
