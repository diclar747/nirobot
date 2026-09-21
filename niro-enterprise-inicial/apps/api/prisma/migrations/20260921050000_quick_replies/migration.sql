CREATE TABLE IF NOT EXISTS "QuickReply" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "shortcut" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "shared" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT,
  "usageCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuickReply_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QuickReply_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "QuickReply_organizationId_shortcut_key" ON "QuickReply"("organizationId", "shortcut");
CREATE INDEX IF NOT EXISTS "QuickReply_organizationId_usageCount_idx" ON "QuickReply"("organizationId", "usageCount");
