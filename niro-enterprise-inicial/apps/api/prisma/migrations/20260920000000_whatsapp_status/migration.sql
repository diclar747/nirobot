-- WhatsApp "estados" (stories) published by contacts; kept for 24 hours.
CREATE TABLE "WhatsappStatus" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT,
    "participantJid" TEXT NOT NULL,
    "phone" TEXT,
    "displayName" TEXT,
    "waMessageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "caption" TEXT,
    "backgroundColor" TEXT,
    "mimeType" TEXT,
    "storageKey" TEXT,
    "fromMe" BOOLEAN NOT NULL DEFAULT false,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappStatus_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsappStatus_organizationId_expiresAt_idx" ON "WhatsappStatus"("organizationId", "expiresAt");

CREATE UNIQUE INDEX "WhatsappStatus_organizationId_waMessageId_key" ON "WhatsappStatus"("organizationId", "waMessageId");

ALTER TABLE "WhatsappStatus" ADD CONSTRAINT "WhatsappStatus_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhatsappStatus" ADD CONSTRAINT "WhatsappStatus_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
