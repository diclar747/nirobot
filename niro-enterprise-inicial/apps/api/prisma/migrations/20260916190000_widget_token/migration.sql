-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "widgetToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_widgetToken_key" ON "Conversation"("widgetToken");

