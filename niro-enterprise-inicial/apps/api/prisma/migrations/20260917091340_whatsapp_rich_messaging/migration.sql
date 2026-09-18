-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "avatarUrl" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "quotedMessageId" TEXT,
ADD COLUMN     "quotedPreview" TEXT,
ADD COLUMN     "quotedSender" TEXT,
ADD COLUMN     "reactions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "waMessageId" TEXT;

-- CreateIndex
CREATE INDEX "Message_conversationId_waMessageId_idx" ON "Message"("conversationId", "waMessageId");

