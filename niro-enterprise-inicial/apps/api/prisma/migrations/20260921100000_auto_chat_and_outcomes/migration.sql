-- Auto chat por agente. Los agentes que ya existen lo conservan activado: hoy ya ven los chats nuevos sin asignar.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "autoChat" BOOLEAN NOT NULL DEFAULT false;
UPDATE "User" SET "autoChat" = true WHERE "role" = 'AGENT';

CREATE TABLE IF NOT EXISTS "OutcomeCategory" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'OTHER',
  "requiresAmount" BOOLEAN NOT NULL DEFAULT false,
  "color" TEXT NOT NULL DEFAULT '#64748b',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutcomeCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OutcomeCategory_organizationId_name_key" ON "OutcomeCategory"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "OutcomeCategory_organizationId_active_sortOrder_idx" ON "OutcomeCategory"("organizationId", "active", "sortOrder");
ALTER TABLE "OutcomeCategory" ADD CONSTRAINT "OutcomeCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ConversationOutcome" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId" TEXT,
  "agentId" TEXT,
  "agentName" TEXT NOT NULL,
  "categoryId" TEXT,
  "categoryName" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'OTHER',
  "amount" DECIMAL(14,2),
  "note" TEXT,
  "closedConversation" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationOutcome_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ConversationOutcome_organizationId_createdAt_idx" ON "ConversationOutcome"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "ConversationOutcome_organizationId_agentId_createdAt_idx" ON "ConversationOutcome"("organizationId", "agentId", "createdAt");
CREATE INDEX IF NOT EXISTS "ConversationOutcome_conversationId_idx" ON "ConversationOutcome"("conversationId");
ALTER TABLE "ConversationOutcome" ADD CONSTRAINT "ConversationOutcome_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationOutcome" ADD CONSTRAINT "ConversationOutcome_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationOutcome" ADD CONSTRAINT "ConversationOutcome_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationOutcome" ADD CONSTRAINT "ConversationOutcome_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationOutcome" ADD CONSTRAINT "ConversationOutcome_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "OutcomeCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
