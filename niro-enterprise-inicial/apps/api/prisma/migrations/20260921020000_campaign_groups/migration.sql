ALTER TABLE "CampaignRecipient" ALTER COLUMN "contactId" DROP NOT NULL;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "groupJid" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "groupName" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_groupJid_key" ON "CampaignRecipient"("campaignId", "groupJid");
