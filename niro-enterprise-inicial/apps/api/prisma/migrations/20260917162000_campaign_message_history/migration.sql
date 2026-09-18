ALTER TABLE "Message" ADD COLUMN "campaignId" TEXT;

CREATE INDEX "Message_campaignId_createdAt_idx" ON "Message"("campaignId", "createdAt");

ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
