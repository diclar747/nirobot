CREATE TABLE "WhatsappGroup" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "jid" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "ownerJid" TEXT,
  "ownerPhone" TEXT,
  "groupCreatedAt" TIMESTAMP(3),
  "announce" BOOLEAN NOT NULL DEFAULT false,
  "size" INTEGER NOT NULL DEFAULT 0,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsappGroup_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WhatsappGroupMember" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "jid" TEXT NOT NULL,
  "lid" TEXT,
  "phone" TEXT,
  "name" TEXT,
  "role" TEXT,
  "isSelf" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "WhatsappGroupMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WhatsappGroup_organizationId_jid_key" ON "WhatsappGroup"("organizationId", "jid");
CREATE INDEX "WhatsappGroup_organizationId_name_idx" ON "WhatsappGroup"("organizationId", "name");
CREATE UNIQUE INDEX "WhatsappGroupMember_groupId_jid_key" ON "WhatsappGroupMember"("groupId", "jid");
CREATE INDEX "WhatsappGroupMember_groupId_idx" ON "WhatsappGroupMember"("groupId");
ALTER TABLE "WhatsappGroup" ADD CONSTRAINT "WhatsappGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsappGroupMember" ADD CONSTRAINT "WhatsappGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsappGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
