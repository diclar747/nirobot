ALTER TABLE "OrganizationSettings" ADD COLUMN IF NOT EXISTS "autoTranscribeAudio" BOOLEAN NOT NULL DEFAULT false;
