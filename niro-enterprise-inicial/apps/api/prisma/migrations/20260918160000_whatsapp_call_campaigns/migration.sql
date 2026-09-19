-- WhatsApp voice-call campaigns. Calls remain separate from message campaigns so
-- an unavailable/non-official voice provider can never change message delivery data.
CREATE TYPE "CallCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "CallRecipientStatus" AS ENUM ('PENDING', 'QUEUED', 'STARTING', 'RINGING', 'CONNECTED', 'PLAYING', 'COMPLETED', 'NO_ANSWER', 'FAILED', 'CANCELLED', 'RETRY_PENDING');

ALTER TABLE "Contact"
  ADD COLUMN "callConsentStatus" TEXT DEFAULT 'UNKNOWN',
  ADD COLUMN "callConsentAt" TIMESTAMP(3),
  ADD COLUMN "callConsentSource" TEXT,
  ADD COLUMN "callOptedOutAt" TIMESTAMP(3),
  ADD COLUMN "callOptOutSource" TEXT;

CREATE TABLE "CallAccount" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phoneNumber" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
  "sessionReference" TEXT,
  "lastError" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CallAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallAudio" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "durationSeconds" INTEGER,
  "processingStatus" TEXT NOT NULL DEFAULT 'READY',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CallAudio_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallCampaign" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "campaignType" TEXT NOT NULL DEFAULT 'COMMERCIAL',
  "accountId" TEXT NOT NULL,
  "audioId" TEXT NOT NULL,
  "status" "CallCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "scheduledAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "timezone" TEXT NOT NULL DEFAULT 'America/Asuncion',
  "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
  "pauseBetweenSeconds" INTEGER NOT NULL DEFAULT 10,
  "maxAttempts" INTEGER NOT NULL DEFAULT 1,
  "answerTimeoutSeconds" INTEGER NOT NULL DEFAULT 30,
  "retryDelaySeconds" INTEGER NOT NULL DEFAULT 300,
  "allowedFrom" TEXT,
  "allowedTo" TEXT,
  "surveyEnabled" BOOLEAN NOT NULL DEFAULT false,
  "surveyQuestion" TEXT,
  "surveyResponseMethod" TEXT NOT NULL DEFAULT 'WHATSAPP',
  "surveyExpiresAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CallCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallCampaignRecipient" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  "status" "CallRecipientStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "finalResult" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CallCampaignRecipient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallAttempt" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "campaignContactId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "audioId" TEXT,
  "attemptNumber" INTEGER NOT NULL,
  "status" "CallRecipientStatus" NOT NULL DEFAULT 'STARTING',
  "callId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "durationSeconds" INTEGER,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "providerEventData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallSurvey" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "responseMethod" TEXT NOT NULL DEFAULT 'WHATSAPP',
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallSurvey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallSurveyOption" (
  "id" TEXT NOT NULL,
  "surveyId" TEXT NOT NULL,
  "optionKey" TEXT NOT NULL,
  "optionLabel" TEXT NOT NULL,
  CONSTRAINT "CallSurveyOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallSurveyResponse" (
  "id" TEXT NOT NULL,
  "surveyId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "attemptId" TEXT,
  "responseValue" TEXT NOT NULL,
  "responseChannel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RESPONDED',
  "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallSurveyResponse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "attemptId" TEXT,
  "eventType" TEXT NOT NULL,
  "eventPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallAuditLog" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "campaignId" TEXT,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallSurvey_campaignId_key" ON "CallSurvey"("campaignId");
CREATE UNIQUE INDEX "CallSurveyOption_surveyId_optionKey_key" ON "CallSurveyOption"("surveyId", "optionKey");
CREATE UNIQUE INDEX "CallCampaignRecipient_campaignId_contactId_key" ON "CallCampaignRecipient"("campaignId", "contactId");
CREATE INDEX "Contact_organizationId_callConsentStatus_callOptedOutAt_idx" ON "Contact"("organizationId", "callConsentStatus", "callOptedOutAt");
CREATE INDEX "CallAccount_organizationId_status_updatedAt_idx" ON "CallAccount"("organizationId", "status", "updatedAt");
CREATE INDEX "CallAudio_organizationId_processingStatus_createdAt_idx" ON "CallAudio"("organizationId", "processingStatus", "createdAt");
CREATE INDEX "CallCampaign_organizationId_status_createdAt_idx" ON "CallCampaign"("organizationId", "status", "createdAt");
CREATE INDEX "CallCampaign_accountId_status_idx" ON "CallCampaign"("accountId", "status");
CREATE INDEX "CallCampaignRecipient_campaignId_status_nextAttemptAt_idx" ON "CallCampaignRecipient"("campaignId", "status", "nextAttemptAt");
CREATE INDEX "CallCampaignRecipient_contactId_idx" ON "CallCampaignRecipient"("contactId");
CREATE INDEX "CallAttempt_campaignId_createdAt_idx" ON "CallAttempt"("campaignId", "createdAt");
CREATE INDEX "CallAttempt_campaignContactId_attemptNumber_idx" ON "CallAttempt"("campaignContactId", "attemptNumber");
CREATE INDEX "CallAttempt_callId_idx" ON "CallAttempt"("callId");
CREATE INDEX "CallSurveyResponse_campaignId_respondedAt_idx" ON "CallSurveyResponse"("campaignId", "respondedAt");
CREATE INDEX "CallSurveyResponse_contactId_respondedAt_idx" ON "CallSurveyResponse"("contactId", "respondedAt");
CREATE INDEX "CallEvent_organizationId_createdAt_idx" ON "CallEvent"("organizationId", "createdAt");
CREATE INDEX "CallEvent_campaignId_createdAt_idx" ON "CallEvent"("campaignId", "createdAt");
CREATE INDEX "CallAuditLog_organizationId_createdAt_idx" ON "CallAuditLog"("organizationId", "createdAt");
CREATE INDEX "CallAuditLog_campaignId_createdAt_idx" ON "CallAuditLog"("campaignId", "createdAt");

ALTER TABLE "CallAccount" ADD CONSTRAINT "CallAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAccount" ADD CONSTRAINT "CallAccount_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallAudio" ADD CONSTRAINT "CallAudio_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAudio" ADD CONSTRAINT "CallAudio_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallCampaign" ADD CONSTRAINT "CallCampaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallCampaign" ADD CONSTRAINT "CallCampaign_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CallAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CallCampaign" ADD CONSTRAINT "CallCampaign_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "CallAudio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CallCampaign" ADD CONSTRAINT "CallCampaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallCampaignRecipient" ADD CONSTRAINT "CallCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CallCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallCampaignRecipient" ADD CONSTRAINT "CallCampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CallCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CallCampaignRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CallAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "CallAudio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallSurvey" ADD CONSTRAINT "CallSurvey_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CallCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallSurveyOption" ADD CONSTRAINT "CallSurveyOption_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "CallSurvey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallSurveyResponse" ADD CONSTRAINT "CallSurveyResponse_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "CallSurvey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallSurveyResponse" ADD CONSTRAINT "CallSurveyResponse_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CallCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallSurveyResponse" ADD CONSTRAINT "CallSurveyResponse_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallSurveyResponse" ADD CONSTRAINT "CallSurveyResponse_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "CallAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CallCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "CallAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallAuditLog" ADD CONSTRAINT "CallAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAuditLog" ADD CONSTRAINT "CallAuditLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CallCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
