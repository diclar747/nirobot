ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "smsBalance" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "SmsTransaction" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "note" TEXT,
  "reference" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsTransaction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SmsTransaction_organizationId_createdAt_idx" ON "SmsTransaction"("organizationId", "createdAt");
ALTER TABLE "SmsTransaction" ADD CONSTRAINT "SmsTransaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "SmsPurchase" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "credits" INTEGER NOT NULL,
  "unitPrice" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "source" TEXT NOT NULL DEFAULT 'CARD',
  "winsapLinkId" TEXT,
  "winsapLinkToken" TEXT,
  "paymentUrl" TEXT,
  "winsapPaymentId" TEXT,
  "paymentMethod" TEXT,
  "note" TEXT,
  "createdByUserId" TEXT,
  "paidAt" TIMESTAMP(3),
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsPurchase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SmsPurchase_organizationId_createdAt_idx" ON "SmsPurchase"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "SmsPurchase_status_idx" ON "SmsPurchase"("status");
ALTER TABLE "SmsPurchase" ADD CONSTRAINT "SmsPurchase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "SmsCampaign" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "stripAccents" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL DEFAULT 'CAMPAIGN',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "pauseReason" TEXT,
  "scheduledAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmsCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SmsCampaign_organizationId_status_createdAt_idx" ON "SmsCampaign"("organizationId", "status", "createdAt");
ALTER TABLE "SmsCampaign" ADD CONSTRAINT "SmsCampaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "SmsMessage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "campaignId" TEXT,
  "contactId" TEXT,
  "name" TEXT,
  "phone" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "encoding" TEXT NOT NULL DEFAULT 'gsm7',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "providerMessageId" TEXT,
  "errorMessage" TEXT,
  "credits" INTEGER NOT NULL DEFAULT 1,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SmsMessage_organizationId_createdAt_idx" ON "SmsMessage"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "SmsMessage_campaignId_status_idx" ON "SmsMessage"("campaignId", "status");
CREATE INDEX IF NOT EXISTS "SmsMessage_providerMessageId_idx" ON "SmsMessage"("providerMessageId");
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SmsCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
