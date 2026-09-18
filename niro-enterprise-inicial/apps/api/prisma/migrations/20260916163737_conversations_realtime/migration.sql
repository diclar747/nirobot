/*
  Warnings:

  - Changed the type of `direction` on the `Message` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ConversationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'NOTE');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "priority" "ConversationPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "direction",
ADD COLUMN     "direction" "MessageDirection" NOT NULL;

-- CreateIndex
CREATE INDEX "Conversation_tags_idx" ON "Conversation" USING GIN ("tags");
