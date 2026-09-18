ALTER TABLE "Campaign" ADD COLUMN "sendLine" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "campaignType" TEXT NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "Campaign" ADD COLUMN "speedProfile" TEXT NOT NULL DEFAULT 'BALANCED';
ALTER TABLE "Campaign" ADD COLUMN "messagesPerHour" INTEGER NOT NULL DEFAULT 40;

CREATE INDEX "Campaign_organizationId_campaignType_idx" ON "Campaign"("organizationId", "campaignType");
