-- AI-generated voice resources for WhatsApp calls.
ALTER TABLE "CallAudio"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'UPLOAD',
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "voice" TEXT,
  ADD COLUMN "language" TEXT;
