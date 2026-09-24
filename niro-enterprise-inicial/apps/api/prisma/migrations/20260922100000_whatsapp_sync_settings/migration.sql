ALTER TABLE "OrganizationSettings" ADD COLUMN "syncGroupsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrganizationSettings" ADD COLUMN "syncContactsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrganizationSettings" ADD COLUMN "syncMessageHistoryEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrganizationSettings" ADD COLUMN "syncAvatarsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrganizationSettings" ADD COLUMN "syncStatusesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "imported" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "WhatsappSyncJob" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "total" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "detail" JSONB,
  "message" TEXT,
  "requestedByUserId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "WhatsappSyncJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WhatsappSyncJob_organizationId_type_startedAt_idx" ON "WhatsappSyncJob"("organizationId", "type", "startedAt");
ALTER TABLE "WhatsappSyncJob" ADD CONSTRAINT "WhatsappSyncJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
