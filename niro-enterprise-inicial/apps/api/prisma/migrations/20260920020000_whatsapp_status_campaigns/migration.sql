-- Campañas de estados: serie de publicaciones que salen automáticamente cada N horas.
CREATE TABLE "WhatsappStatusCampaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "name" TEXT NOT NULL,
    "intervalHours" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "replacePrevious" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "totalItems" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappStatusCampaign_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WhatsappStatusPost" ADD COLUMN "campaignId" TEXT, ADD COLUMN "sequence" INTEGER;

CREATE INDEX "WhatsappStatusCampaign_organizationId_status_idx" ON "WhatsappStatusCampaign"("organizationId", "status");
CREATE INDEX "WhatsappStatusPost_campaignId_sequence_idx" ON "WhatsappStatusPost"("campaignId", "sequence");

ALTER TABLE "WhatsappStatusCampaign" ADD CONSTRAINT "WhatsappStatusCampaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsappStatusPost" ADD CONSTRAINT "WhatsappStatusPost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsappStatusCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
