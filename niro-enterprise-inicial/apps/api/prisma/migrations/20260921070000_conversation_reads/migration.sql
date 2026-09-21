CREATE TABLE IF NOT EXISTS "ConversationRead" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationRead_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationRead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationRead_conversationId_userId_key" ON "ConversationRead"("conversationId", "userId");
CREATE INDEX IF NOT EXISTS "ConversationRead_userId_idx" ON "ConversationRead"("userId");

-- Lo que ya existe se considera leído (para que el historial no aparezca como "no leído" al estrenar).
INSERT INTO "ConversationRead" ("id", "conversationId", "userId", "lastReadAt")
SELECT gen_random_uuid()::text, c."id", u."id", NOW()
FROM "Conversation" c JOIN "User" u ON u."organizationId" = c."organizationId" AND u."active" = true
ON CONFLICT DO NOTHING;
