-- Estados de WhatsApp publicados desde Nirobot (cola en base de datos) y sus intentos.
CREATE TABLE "WhatsappStatusPost" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "contentType" TEXT NOT NULL,
    "textContent" TEXT,
    "caption" TEXT,
    "mediaStorageKey" TEXT,
    "mimeType" TEXT,
    "backgroundColor" TEXT,
    "fontStyle" INTEGER,
    "audienceType" TEXT NOT NULL,
    "audienceTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceContactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceCount" INTEGER NOT NULL DEFAULT 0,
    "publicationMode" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "nextAttemptAt" TIMESTAMP(3),
    "waMessageId" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappStatusPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsappStatusAttempt" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "successful" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,

    CONSTRAINT "WhatsappStatusAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsappStatusPost_organizationId_status_createdAt_idx" ON "WhatsappStatusPost"("organizationId", "status", "createdAt");

CREATE INDEX "WhatsappStatusPost_status_nextAttemptAt_idx" ON "WhatsappStatusPost"("status", "nextAttemptAt");

CREATE INDEX "WhatsappStatusAttempt_postId_idx" ON "WhatsappStatusAttempt"("postId");

ALTER TABLE "WhatsappStatusPost" ADD CONSTRAINT "WhatsappStatusPost_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhatsappStatusAttempt" ADD CONSTRAINT "WhatsappStatusAttempt_postId_fkey" FOREIGN KEY ("postId") REFERENCES "WhatsappStatusPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
