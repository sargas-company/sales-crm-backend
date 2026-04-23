-- CreateEnum
CREATE TYPE "CounterpartyType" AS ENUM ('client', 'contractor');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'open', 'paid');

-- CreateTable
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "type" "CounterpartyType" NOT NULL,
    "info" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "header" TEXT NOT NULL DEFAULT 'INVOICE',
    "logoUrl" TEXT,
    "number" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "date" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "paymentTerms" TEXT,
    "poNumber" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "shipTo" TEXT,
    "notes" TEXT,
    "terms" TEXT,
    "tax" DECIMAL(10,2),
    "discounts" DECIMAL(10,2),
    "shipping" DECIMAL(10,2),
    "amountPaid" DECIMAL(10,2),
    "showTax" BOOLEAN NOT NULL DEFAULT false,
    "showDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "showShipping" BOOLEAN NOT NULL DEFAULT false,
    "showShipTo" BOOLEAN NOT NULL DEFAULT false,
    "pdfUrl" TEXT,
    "labels" JSONB NOT NULL DEFAULT '{}',
    "customFields" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(10,3) NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Counterparty_type_idx" ON "Counterparty"("type");

-- CreateIndex
CREATE INDEX "Invoice_counterpartyId_idx" ON "Invoice"("counterpartyId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_createdAt_idx" ON "Invoice"("createdAt");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_invoiceId_idx" ON "InvoiceLineItem"("invoiceId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
