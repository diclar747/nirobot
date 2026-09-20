ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "paidUntil" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "billingExempt" BOOLEAN NOT NULL DEFAULT false;

-- Organizaciones ya existentes: 24 h de prueba a partir de este despliegue (no se bloquean de golpe).
UPDATE "Organization" SET "trialEndsAt" = NOW() + INTERVAL '24 hours' WHERE "trialEndsAt" IS NULL;

CREATE TABLE IF NOT EXISTS "BillingPayment" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'PYG',
  "periodDays" INTEGER NOT NULL DEFAULT 30,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "winsapLinkId" TEXT,
  "winsapLinkToken" TEXT,
  "paymentUrl" TEXT,
  "winsapPaymentId" TEXT,
  "paymentMethod" TEXT,
  "paidAt" TIMESTAMP(3),
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BillingPayment_organizationId_createdAt_idx" ON "BillingPayment"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "BillingPayment_status_idx" ON "BillingPayment"("status");

CREATE TABLE IF NOT EXISTS "PlatformNotice" (
  "id" TEXT NOT NULL,
  "audience" TEXT NOT NULL DEFAULT 'all',
  "organizationId" TEXT,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "level" TEXT NOT NULL DEFAULT 'info',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformNotice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformNotice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PlatformNotice_createdAt_idx" ON "PlatformNotice"("createdAt");

CREATE TABLE IF NOT EXISTS "PlatformNoticeRead" (
  "id" TEXT NOT NULL,
  "noticeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformNoticeRead_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformNoticeRead_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "PlatformNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformNoticeRead_noticeId_userId_key" ON "PlatformNoticeRead"("noticeId", "userId");
