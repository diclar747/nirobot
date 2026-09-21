CREATE TABLE IF NOT EXISTS "WhatsappStatusView" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "waMessageId" TEXT NOT NULL,
  "viewerJid" TEXT NOT NULL,
  "phone" TEXT,
  "displayName" TEXT,
  "contactId" TEXT,
  "viewedAt" TIMESTAMP(3),
  "reaction" TEXT,
  "reactedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsappStatusView_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappStatusView_organizationId_waMessageId_viewerJid_key" ON "WhatsappStatusView"("organizationId", "waMessageId", "viewerJid");
CREATE INDEX IF NOT EXISTS "WhatsappStatusView_organizationId_waMessageId_idx" ON "WhatsappStatusView"("organizationId", "waMessageId");
ALTER TABLE "WhatsappStatusView" ADD CONSTRAINT "WhatsappStatusView_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
