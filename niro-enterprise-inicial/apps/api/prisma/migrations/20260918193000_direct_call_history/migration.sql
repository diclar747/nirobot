-- Persistent history for individual calls started from the inbox.
CREATE TABLE "CallDirectRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "contactId" TEXT,
  "conversationId" TEXT,
  "createdByUserId" TEXT,
  "phoneNumber" TEXT NOT NULL,
  "status" "CallRecipientStatus" NOT NULL DEFAULT 'STARTING',
  "callId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "durationSeconds" INTEGER,
  "endedReason" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "providerEventData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallDirectRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallDirectRecord_organizationId_createdAt_idx" ON "CallDirectRecord"("organizationId", "createdAt");
CREATE INDEX "CallDirectRecord_organizationId_status_createdAt_idx" ON "CallDirectRecord"("organizationId", "status", "createdAt");
CREATE INDEX "CallDirectRecord_contactId_createdAt_idx" ON "CallDirectRecord"("contactId", "createdAt");
CREATE INDEX "CallDirectRecord_callId_idx" ON "CallDirectRecord"("callId");

ALTER TABLE "CallDirectRecord" ADD CONSTRAINT "CallDirectRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallDirectRecord" ADD CONSTRAINT "CallDirectRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CallAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CallDirectRecord" ADD CONSTRAINT "CallDirectRecord_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallDirectRecord" ADD CONSTRAINT "CallDirectRecord_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallDirectRecord" ADD CONSTRAINT "CallDirectRecord_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
