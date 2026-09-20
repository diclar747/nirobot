const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');
const { resolvePath } = require('./storage');
const whatsapp = require('./whatsapp');
const callProvider = require('./callProvider');

const workers = new Map();
const scheduledTimers = new Map();
const accountLocks = new Set();
const activeCalls = new Map();
const directCalls = new Map();
let stopping = false;

const ANSWERED_END_REASONS = new Set(['audio_complete', 'remote_end', 'hangup', 'ended']);
const STATUS_TERMINAL = new Set(['COMPLETED', 'NO_ANSWER', 'FAILED', 'CANCELLED']);
const STATUS_ACTIVE = new Set(['STARTING', 'RINGING', 'CONNECTED', 'PLAYING']);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function providerState() {
  return callProvider.providerInfo();
}

function sanitizeDirectCall(call) {
  if (!call) return null;
  return {
    id: call.id,
    callId: call.callId,
    recordId: call.recordId || null,
    phoneNumber: call.phoneNumber,
    accountId: call.accountId,
    contactId: call.contactId || null,
    conversationId: call.conversationId || null,
    status: call.status,
    startedAt: call.startedAt,
    connectedAt: call.connectedAt || null,
    finishedAt: call.finishedAt || null,
    durationSeconds: call.durationSeconds || 0,
    endedReason: call.endedReason || null
  };
}

function updateDirectRecord(recordId, data) {
  if (!recordId) return Promise.resolve(null);
  return prisma.callDirectRecord.update({ where: { id: recordId }, data }).catch((error) => {
    console.error('[wa-calls] no se pudo actualizar el historial de llamada directa', error.message || error);
    return null;
  });
}

function sanitizeAccount(account, statusOverride) {
  if (!account) return null;
  return {
    id: account.id,
    name: account.name,
    phoneNumber: account.phoneNumber,
    status: statusOverride || account.status,
    lastError: account.lastError,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function sanitizeAudio(audio) {
  if (!audio) return null;
  return {
    id: audio.id,
    name: audio.name,
    description: audio.description,
    mimeType: audio.mimeType,
    size: audio.size,
    durationSeconds: audio.durationSeconds,
    processingStatus: audio.processingStatus,
    source: audio.source || 'UPLOAD',
    provider: audio.provider || null,
    voice: audio.voice || null,
    language: audio.language || null,
    createdAt: audio.createdAt,
    updatedAt: audio.updatedAt,
    fileUrl: `/api/org/wa-calls/audios/${audio.id}/file`
  };
}

function sanitizeCampaign(campaign, counts = {}) {
  if (!campaign) return null;
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    campaignType: campaign.campaignType,
    status: campaign.status,
    scheduledAt: campaign.scheduledAt,
    startedAt: campaign.startedAt,
    completedAt: campaign.completedAt,
    timezone: campaign.timezone,
    maxConcurrent: campaign.maxConcurrent,
    pauseBetweenSeconds: campaign.pauseBetweenSeconds,
    maxAttempts: campaign.maxAttempts,
    answerTimeoutSeconds: campaign.answerTimeoutSeconds,
    retryDelaySeconds: campaign.retryDelaySeconds,
    allowedFrom: campaign.allowedFrom,
    allowedTo: campaign.allowedTo,
    surveyEnabled: campaign.surveyEnabled,
    surveyQuestion: campaign.surveyQuestion,
    surveyResponseMethod: campaign.surveyResponseMethod,
    surveyExpiresAt: campaign.surveyExpiresAt,
    account: sanitizeAccount(campaign.account),
    audio: sanitizeAudio(campaign.audio),
    createdBy: campaign.createdBy ? { id: campaign.createdBy.id, name: campaign.createdBy.name } : null,
    counts,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt
  };
}

async function getCounts(campaignId) {
  const grouped = await prisma.callCampaignRecipient.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true }
  });
  const counts = {
    total: 0, pending: 0, queued: 0, inProgress: 0, connected: 0,
    completed: 0, noAnswer: 0, failed: 0, cancelled: 0, retryPending: 0,
    attempts: 0, surveyPending: 0, surveyResponses: 0
  };
  for (const group of grouped) {
    const value = group._count._all;
    counts.total += value;
    if (group.status === 'PENDING') counts.pending += value;
    if (group.status === 'QUEUED') counts.queued += value;
    if (['STARTING', 'RINGING', 'CONNECTED', 'PLAYING'].includes(group.status)) counts.inProgress += value;
    if (['CONNECTED', 'PLAYING', 'COMPLETED'].includes(group.status)) counts.connected += value;
    if (group.status === 'COMPLETED') counts.completed += value;
    if (group.status === 'NO_ANSWER') counts.noAnswer += value;
    if (group.status === 'FAILED') counts.failed += value;
    if (group.status === 'CANCELLED') counts.cancelled += value;
    if (group.status === 'RETRY_PENDING') counts.retryPending += value;
  }
  const [attempts, surveyPending, surveyResponses] = await Promise.all([
    prisma.callAttempt.count({ where: { campaignId } }),
    prisma.callCampaignRecipient.count({ where: { campaignId, status: { in: ['COMPLETED'] } } }),
    prisma.callSurveyResponse.count({ where: { campaignId, status: 'RESPONDED' } })
  ]);
  counts.attempts = attempts;
  counts.surveyPending = surveyPending;
  counts.surveyResponses = surveyResponses;
  return counts;
}

const CAMPAIGN_INCLUDE = {
  account: true,
  audio: true,
  createdBy: { select: { id: true, name: true } },
  survey: { include: { options: true } }
};

async function findCampaign(organizationId, campaignId) {
  return prisma.callCampaign.findFirst({ where: { id: campaignId, organizationId }, include: CAMPAIGN_INCLUDE });
}

async function emitCampaignUpdate(organizationId, campaignId) {
  const campaign = await prisma.callCampaign.findUnique({ where: { id: campaignId }, include: CAMPAIGN_INCLUDE });
  if (!campaign) return;
  emitToOrg(organizationId, 'wa-call:updated', {
    campaign: sanitizeCampaign(campaign, await getCounts(campaignId)),
    provider: providerState()
  });
}

async function recordEvent(organizationId, campaignId, attemptId, eventType, eventPayload = null) {
  await prisma.callEvent.create({
    data: { organizationId, campaignId, attemptId, eventType, eventPayload }
  });
  emitToOrg(organizationId, 'wa-call:event', { campaignId, attemptId, eventType, eventPayload });
}

function isWithinWindow(campaign) {
  if (!campaign.allowedFrom || !campaign.allowedTo) return true;
  const now = new Intl.DateTimeFormat('en-GB', {
    timeZone: campaign.timezone || 'America/Asuncion',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
  const current = now.replace(':', '');
  const from = campaign.allowedFrom.replace(':', '');
  const to = campaign.allowedTo.replace(':', '');
  return from <= to ? current >= from && current <= to : current >= from || current <= to;
}

async function assertRunnable(campaign) {
  if (!isWithinWindow(campaign)) {
    const error = new Error('La campaña está fuera de la ventana horaria permitida');
    error.status = 409;
    throw error;
  }
  const info = providerState();
  if (!info.available) {
    const error = new Error(info.reason);
    error.status = 409;
    error.code = 'CALL_PROVIDER_UNAVAILABLE';
    throw error;
  }
  if (info.mode !== 'mock' && whatsapp.getStatus(campaign.organizationId).status !== 'connected') {
    const error = new Error('La cuenta de WhatsApp no está conectada');
    error.status = 409;
    throw error;
  }
}

function surveyText(campaign, survey) {
  if (!survey || !survey.options || survey.options.length === 0) return null;
  return [
    campaign.surveyQuestion || survey.question,
    '',
    ...survey.options.map((option) => `${option.optionKey} — ${option.optionLabel}`),
    '',
    'Respondé con el número de tu opción.'
  ].join('\n');
}

async function sendSurveyIfNeeded(campaign, recipient, attempt) {
  if (!campaign.surveyEnabled || !campaign.survey || campaign.survey.responseMethod !== 'WHATSAPP') return;
  const text = surveyText(campaign, campaign.survey);
  if (!text || providerState().mode === 'mock') {
    await recordEvent(campaign.organizationId, campaign.id, attempt.id, 'SURVEY_PENDING', { simulated: providerState().mode === 'mock' });
    return;
  }
  try {
    const waMessageId = await whatsapp.sendText(campaign.organizationId, recipient.phoneNumber, text);
    await recordEvent(campaign.organizationId, campaign.id, attempt.id, 'SURVEY_SENT', { waMessageId });
  } catch (err) {
    await recordEvent(campaign.organizationId, campaign.id, attempt.id, 'SURVEY_SEND_FAILED', { message: err.message });
  }
}

async function finishRecipient(campaign, recipient, attempt, status, details = {}) {
  const now = new Date();
  const finalStatus = status;
  const shouldRetry = !['COMPLETED', 'CANCELLED'].includes(status) && attempt.attemptNumber < campaign.maxAttempts;
  const nextAttemptAt = shouldRetry ? new Date(now.getTime() + campaign.retryDelaySeconds * 1000) : null;
  const recipientStatus = shouldRetry ? 'RETRY_PENDING' : finalStatus;
  const finalResult = shouldRetry ? 'RETRY_SCHEDULED' : (details.finalResult || finalStatus);

  await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      status: finalStatus,
      finishedAt: now,
      durationSeconds: details.durationSeconds,
      errorCode: details.errorCode || null,
      errorMessage: details.errorMessage || null,
      providerEventData: details.providerEventData || null
    }
  });
  await prisma.callCampaignRecipient.update({
    where: { id: recipient.id },
    data: { status: recipientStatus, finalResult, nextAttemptAt }
  });
  await recordEvent(campaign.organizationId, campaign.id, attempt.id, finalStatus, {
    ...details,
    attemptNumber: attempt.attemptNumber,
    retryScheduled: shouldRetry
  });
  return { shouldRetry, recipientStatus };
}

async function runAttempt(campaign, recipient) {
  const attemptNumber = recipient.attemptCount + 1;
  const attempt = await prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: recipient.id,
      accountId: campaign.accountId,
      audioId: campaign.audioId,
      attemptNumber,
      status: 'STARTING'
    }
  });
  await prisma.callCampaignRecipient.update({
    where: { id: recipient.id },
    data: { status: 'STARTING', attemptCount: attemptNumber, lastAttemptAt: new Date() }
  });
  await recordEvent(campaign.organizationId, campaign.id, attempt.id, 'STARTING', { phoneNumber: recipient.phoneNumber, attemptNumber });

  const startedAt = Date.now();
  let connected = false;
  let call = null;
  let transitionChain = Promise.resolve();
  const transition = (status, data = {}) => {
    transitionChain = transitionChain.then(async () => {
      await prisma.callAttempt.update({ where: { id: attempt.id }, data: { status, ...(data.answeredAt ? { answeredAt: data.answeredAt } : {}) } });
      await prisma.callCampaignRecipient.update({ where: { id: recipient.id }, data: { status } });
      await recordEvent(campaign.organizationId, campaign.id, attempt.id, status, data);
      await emitCampaignUpdate(campaign.organizationId, campaign.id);
    });
    return transitionChain;
  };

  try {
    const audioPath = resolvePath(campaign.audio.storageKey);
    if (providerState().mode !== 'mock' && !fs.existsSync(audioPath)) {
      const error = new Error('El archivo de audio ya no está disponible en el almacenamiento');
      error.code = 'AUDIO_NOT_FOUND';
      throw error;
    }
    call = await callProvider.startCall(campaign.account, recipient.phoneNumber, {
      organizationId: campaign.organizationId,
      audioSource: audioPath,
      answerTimeoutMs: campaign.answerTimeoutSeconds * 1000,
      durationMs: 30 * 60 * 1000
    });
    activeCalls.set(attempt.id, call);
    await prisma.callAttempt.update({ where: { id: attempt.id }, data: { callId: call.callId || null } });

    call.on('ringing', () => { transition('RINGING').catch(() => {}); });
    call.on('connected', () => {
      connected = true;
      transition('CONNECTED', { answeredAt: new Date() }).catch(() => {});
    });
    call.on('audio-started', () => { transition('PLAYING').catch(() => {}); });
    call.on('error', (err) => { recordEvent(campaign.organizationId, campaign.id, attempt.id, 'ERROR', { message: err.message }).catch(() => {}); });

    const reason = await call.waitForEnd();
    await transitionChain;
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const currentCampaign = await prisma.callCampaign.findUnique({ where: { id: campaign.id }, select: { status: true } });
    // Someone who picked up and later hung up was reached: that is a completed contact, not a
    // failure, and must not be dialled again. Only transport/provider errors count as FAILED.
    const status = currentCampaign?.status === 'CANCELLED' ? 'CANCELLED' : connected && ANSWERED_END_REASONS.has(reason) ? 'COMPLETED' : (connected ? 'FAILED' : 'NO_ANSWER');
    const finished = await finishRecipient(campaign, recipient, attempt, status, {
      durationSeconds,
      errorCode: status === 'NO_ANSWER' ? 'NO_ANSWER' : null,
      errorMessage: status === 'NO_ANSWER' ? `Resultado no determinado (${reason || 'sin evento'})` : null,
      providerEventData: { reason, provider: providerState().mode }
    });
    if (status === 'COMPLETED') await sendSurveyIfNeeded(campaign, recipient, attempt);
    return finished;
  } catch (err) {
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    await finishRecipient(campaign, recipient, attempt, 'FAILED', {
      durationSeconds,
      errorCode: err.code || 'CALL_FAILED',
      errorMessage: err.message
    });
    return { shouldRetry: attemptNumber < campaign.maxAttempts, recipientStatus: attemptNumber < campaign.maxAttempts ? 'RETRY_PENDING' : 'FAILED' };
  } finally {
    activeCalls.delete(attempt.id);
    await emitCampaignUpdate(campaign.organizationId, campaign.id);
  }
}

// Consent and opt-out can change after a campaign is created. Check them again right before dialling.
async function contactStillCallable(recipient) {
  const contact = await prisma.contact.findUnique({
    where: { id: recipient.contactId },
    select: { callConsentStatus: true, callOptedOutAt: true }
  });
  return Boolean(contact && !contact.callOptedOutAt && contact.callConsentStatus === 'GRANTED');
}

async function runClaimedRecipient(campaign, recipient) {
  try {
    if (!(await contactStillCallable(recipient))) {
      await prisma.callCampaignRecipient.update({ where: { id: recipient.id }, data: { status: 'CANCELLED', finalResult: 'CONSENT_REVOKED' } });
      await recordEvent(campaign.organizationId, campaign.id, null, 'RECIPIENT_SKIPPED', { recipientId: recipient.id, reason: 'CONSENT_REVOKED' });
      return { shouldRetry: false, recipientStatus: 'CANCELLED' };
    }
    return await runAttempt(campaign, recipient);
  } catch (error) {
    // Never leave a claimed recipient in QUEUED: the worker would wait for it forever.
    console.error('[wa-calls] intento abortado', recipient.id, error.message || error);
    await prisma.callCampaignRecipient.updateMany({
      where: { id: recipient.id, status: { in: ['QUEUED', 'STARTING'] } },
      data: { status: 'FAILED', finalResult: 'INTERNAL_ERROR' }
    }).catch(() => {});
    return { shouldRetry: false, recipientStatus: 'FAILED' };
  }
}

async function claimRecipients(campaign, limit) {
  const due = await prisma.callCampaignRecipient.findMany({
    where: {
      campaignId: campaign.id,
      status: { in: ['PENDING', 'RETRY_PENDING'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }]
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { campaign: true }
  });
  const claimed = [];
  for (const item of due) {
    const result = await prisma.callCampaignRecipient.updateMany({
      where: { id: item.id, status: item.status },
      data: { status: 'QUEUED' }
    });
    if (result.count === 1) claimed.push(item);
  }
  return claimed;
}

async function runWorker(organizationId, campaignId) {
  if (workers.has(campaignId)) return;
  const worker = (async () => {
    try {
      while (!stopping) {
        const campaign = await prisma.callCampaign.findUnique({ where: { id: campaignId }, include: CAMPAIGN_INCLUDE });
        if (!campaign || campaign.status !== 'RUNNING') return;
        if (!isWithinWindow(campaign)) {
          await prisma.callCampaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } });
          await emitCampaignUpdate(organizationId, campaignId);
          return;
        }
        const recipients = await claimRecipients(campaign, 1);
        if (recipients.length === 0) {
          const pending = await prisma.callCampaignRecipient.count({ where: { campaignId, status: { in: ['PENDING', 'QUEUED', 'RETRY_PENDING'] } } });
          if (pending === 0) {
            await prisma.callCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED', completedAt: new Date() } });
            await recordEvent(organizationId, campaignId, null, 'CAMPAIGN_COMPLETED');
            await emitCampaignUpdate(organizationId, campaignId);
            return;
          }
          await delay(250);
          continue;
        }
        await Promise.all(recipients.map((recipient) => runClaimedRecipient(campaign, recipient)));
        await delay(campaign.pauseBetweenSeconds * 1000);
      }
    } catch (err) {
      console.error('[wa-calls] worker error', campaignId, err);
      await prisma.callCampaign.updateMany({ where: { id: campaignId, status: 'RUNNING' }, data: { status: 'PAUSED' } }).catch(() => {});
      await recordEvent(organizationId, campaignId, null, 'WORKER_ERROR', { message: err.message }).catch(() => {});
      await emitCampaignUpdate(organizationId, campaignId).catch(() => {});
    } finally {
      workers.delete(campaignId);
      const lockedCampaign = await prisma.callCampaign.findUnique({ where: { id: campaignId }, select: { accountId: true } }).catch(() => null);
      if (lockedCampaign) accountLocks.delete(lockedCampaign.accountId);
    }
  })();
  workers.set(campaignId, worker);
}

async function startCampaign(organizationId, campaignId) {
  const campaign = await findCampaign(organizationId, campaignId);
  if (!campaign) throw Object.assign(new Error('Campaña de llamadas no encontrada'), { status: 404 });
  if (campaign.status === 'RUNNING') return campaign;
  if (await require('./billing').isBlocked(organizationId).catch(() => false)) {
    throw Object.assign(new Error('Tu plan venció: activalo para iniciar campañas de llamadas'), { status: 402 });
  }
  await assertRunnable(campaign);
  if (accountLocks.has(campaign.accountId)) {
    const error = new Error('La cuenta de WhatsApp ya está ocupada por otra campaña de llamadas');
    error.status = 409;
    throw error;
  }
  accountLocks.add(campaign.accountId);
  try {
    await prisma.callCampaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING', startedAt: campaign.startedAt || new Date(), completedAt: null } });
    await recordEvent(organizationId, campaign.id, null, 'CAMPAIGN_STARTED', { provider: providerState().mode });
  } catch (error) {
    accountLocks.delete(campaign.accountId);
    throw error;
  }
  runWorker(organizationId, campaign.id);
  return findCampaign(organizationId, campaign.id);
}

async function startDirectCall(organizationId, account, phoneNumber, options = {}) {
  const info = providerState();
  if (!info.available) {
    const error = new Error(info.reason);
    error.status = 409;
    error.code = 'CALL_PROVIDER_UNAVAILABLE';
    throw error;
  }
  if (info.mode !== 'mock' && whatsapp.getStatus(organizationId).status !== 'connected') {
    const error = new Error('La cuenta de WhatsApp no está conectada');
    error.status = 409;
    error.code = 'WHATSAPP_NOT_CONNECTED';
    throw error;
  }
  if (accountLocks.has(account.id)) {
    const error = new Error('La cuenta de WhatsApp ya está ocupada por otra llamada');
    error.status = 409;
    error.code = 'CALL_ACCOUNT_BUSY';
    throw error;
  }

  accountLocks.add(account.id);
  const startedAt = new Date();
  let directRecord;
  try {
    directRecord = await prisma.callDirectRecord.create({
      data: {
        id: crypto.randomUUID(),
        organizationId,
        accountId: account.id,
        phoneNumber,
        ...(options.contactId ? { contactId: options.contactId } : {}),
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        ...(options.userId ? { createdByUserId: options.userId } : {}),
        status: 'STARTING',
        startedAt
      }
    });
  } catch (error) {
    accountLocks.delete(account.id);
    throw error;
  }
  let call;
  try {
    call = await callProvider.startCall(account, phoneNumber, {
      organizationId,
      audioSource: 'live',
      answerTimeoutMs: 45000,
      durationMs: Math.max(1000, Number(options.durationMs || process.env.WHATSAPP_DIRECT_CALL_DURATION_MS || 1800000))
    });
  } catch (error) {
    accountLocks.delete(account.id);
    await updateDirectRecord(directRecord.id, {
      status: 'FAILED',
      finishedAt: new Date(),
      durationSeconds: 0,
      endedReason: error.code || 'provider_error',
      errorCode: error.code || 'CALL_FAILED',
      errorMessage: error.message || 'No se pudo iniciar la llamada'
    });
    throw error;
  }

  const directCall = {
    id: crypto.randomUUID(),
    callId: call.callId || crypto.randomUUID(),
    recordId: directRecord.id,
    phoneNumber,
    accountId: account.id,
    organizationId,
    status: 'STARTING',
    contactId: options.contactId || null,
    conversationId: options.conversationId || null,
    startedAt,
    connectedAt: null,
    finishedAt: null,
    durationSeconds: 0,
    endedReason: null,
    requestedHangup: false,
    userId: options.userId,
    audioToken: crypto.randomBytes(32).toString("hex"),
    mediaSocket: null,
    mediaTimer: null,
    connected: false,
    call
  };
  directCalls.set(directCall.id, directCall);
  await updateDirectRecord(directRecord.id, { callId: directCall.callId });

  const finish = async (reason) => {
    if (directCall.finishedAt) return;
    const finishedAt = new Date();
    directCall.finishedAt = finishedAt;
    clearTimeout(directCall.mediaTimer);
    directCall.mediaSocket?.emit("wa-call:ended", { id: directCall.id, reason });
    directCall.endedReason = directCall.endedReason || reason || null;
    // A call that was answered and then ended (by either side) is a normal, finished call.
    // Only calls that never connected are cancelled/unanswered, and only real errors are FAILED.
    const answeredEnd = ['hangup', 'ended', 'remote_end', 'duration_limit', 'audio_complete'].includes(reason);
    directCall.status = directCall.connected && (directCall.requestedHangup || answeredEnd)
      ? 'COMPLETED'
      : directCall.requestedHangup
        ? 'CANCELLED'
        : (['rejected', 'timeout', 'remote_end', 'ended', 'hangup'].includes(reason) ? 'NO_ANSWER' : 'FAILED');
    console.log(`[calls] llamada directa ${directCall.id} terminó: estado=${directCall.status} motivo=${reason} conectada=${directCall.connected} duración=${directCall.connectedAt ? Math.round((finishedAt.getTime() - directCall.connectedAt.getTime()) / 1000) : 0}s`);
    directCall.durationSeconds = directCall.connectedAt
      ? Math.max(0, Math.round((finishedAt.getTime() - directCall.connectedAt.getTime()) / 1000))
      : 0;
    await updateDirectRecord(directCall.recordId, {
      status: directCall.status,
      answeredAt: directCall.connectedAt,
      finishedAt,
      durationSeconds: directCall.durationSeconds,
      endedReason: directCall.endedReason,
      ...(directCall.status === 'FAILED' ? { errorCode: 'CALL_FAILED', errorMessage: directCall.endedReason } : {})
    });
    accountLocks.delete(account.id);
    setTimeout(() => directCalls.delete(directCall.id), 15 * 60 * 1000).unref?.();
  };

  call.on('ringing', () => {
    if (directCall.finishedAt) return;
    console.log(`[calls] llamada directa ${directCall.id}: sonando`);
    directCall.status = 'RINGING';
    updateDirectRecord(directCall.recordId, { status: 'RINGING' });
  });
  call.on('connected', () => {
    if (directCall.finishedAt) return;
    console.log(`[calls] llamada directa ${directCall.id}: contestada`);
    directCall.connected = true;
    directCall.connectedAt = new Date();
    directCall.status = 'CONNECTED';
    updateDirectRecord(directCall.recordId, { status: 'CONNECTED', answeredAt: directCall.connectedAt });
  });
  call.on('error', (error) => {
    if (!directCall.finishedAt) {
      directCall.status = 'FAILED';
      directCall.endedReason = error?.message || 'provider_error';
      updateDirectRecord(directCall.recordId, { status: 'FAILED', errorCode: error?.code || 'CALL_FAILED', errorMessage: directCall.endedReason });
      try { call.end(); } catch {}
    }
  });
  directCall.finishedPromise = Promise.resolve(call.waitForEnd()).then(finish).catch((error) => finish(error?.message || 'provider_error'));

  directCall.mediaTimer = setTimeout(() => { console.warn(`[calls] llamada directa ${directCall.id}: el navegador no enlazó el micrófono a tiempo`); call.end('media_timeout'); }, 30000);
  call.on('audio', pcm => {
    if (!directCall.finishedAt && directCall.mediaSocket?.connected) {
      directCall.mediaSocket.volatile.emit('wa-call:audio', { id: directCall.id, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) });
    }
  });
  if (Number(call.state) === 6) {
    directCall.connected = true;
    directCall.connectedAt = new Date();
    directCall.status = 'CONNECTED';
    updateDirectRecord(directCall.recordId, { status: 'CONNECTED', answeredAt: directCall.connectedAt });
  }
  return { ...sanitizeDirectCall(directCall), audioToken: directCall.audioToken };
}

function bindDirectAudio(auth, id, token, socket) {
  const item = directCalls.get(id);
  if (!item || item.finishedAt || item.organizationId !== auth.organizationId || item.userId !== auth.userId
      || typeof token !== 'string' || token.length !== item.audioToken.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(item.audioToken))) return null;
  if (item.mediaSocket && item.mediaSocket.id !== socket.id && item.mediaSocket.connected) return null;
  clearTimeout(item.mediaTimer);
  item.mediaSocket = socket;
  return {
    push(pcm) { if (!item.finishedAt && item.mediaSocket === socket) item.call.pushAudio?.(pcm); },
    detach() {
      if (item.mediaSocket !== socket || item.finishedAt) return;
      item.mediaSocket = null;
      clearTimeout(item.mediaTimer);
      item.mediaTimer = setTimeout(() => item.call.end('media_disconnected'), 10000);
    }
  };
}

function getDirectCall(organizationId, callId) {
  const directCall = [...directCalls.values()].find((item) => item.organizationId === organizationId && (item.id === callId || item.callId === callId));
  return sanitizeDirectCall(directCall);
}

async function endDirectCall(organizationId, callId) {
  const directCall = [...directCalls.values()].find((item) => item.organizationId === organizationId && (item.id === callId || item.callId === callId));
  if (!directCall) return null;
  if (!directCall.finishedAt) {
    directCall.requestedHangup = true;
    try { directCall.call.end(); } catch (error) { directCall.endedReason = error?.message || 'hangup_error'; }
  }
  await directCall.finishedPromise;
  return sanitizeDirectCall(directCall);
}

function pauseCampaign(campaignId) {
  return workers.get(campaignId) || null;
}

async function cancelCampaign(organizationId, campaignId) {
  const existing = await findCampaign(organizationId, campaignId);
  if (!existing) throw Object.assign(new Error('Campaña de llamadas no encontrada'), { status: 404 });
  if (['COMPLETED', 'CANCELLED'].includes(existing.status)) {
    throw Object.assign(new Error('La campaña ya terminó'), { status: 409 });
  }
  for (const [attemptId, call] of activeCalls.entries()) {
    const attempt = await prisma.callAttempt.findUnique({ where: { id: attemptId }, select: { campaignId: true } }).catch(() => null);
    if (attempt && attempt.campaignId === campaignId) {
      try { call.end(); } catch {}
    }
  }
  await prisma.callCampaignRecipient.updateMany({
    where: { campaignId, status: { in: ['PENDING', 'QUEUED', 'RETRY_PENDING'] } },
    data: { status: 'CANCELLED', finalResult: 'CANCELLED' }
  });
  await prisma.callCampaign.update({ where: { id: campaignId }, data: { status: 'CANCELLED', completedAt: new Date() } });
  await recordEvent(organizationId, campaignId, null, 'CAMPAIGN_CANCELLED');
  return findCampaign(organizationId, campaignId);
}

function scheduleCampaign(organizationId, campaignId, scheduledAt) {
  if (scheduledTimers.has(campaignId)) clearTimeout(scheduledTimers.get(campaignId));
  const delayMs = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  const timer = setTimeout(async () => {
    scheduledTimers.delete(campaignId);
    const current = await findCampaign(organizationId, campaignId);
    if (current && current.status === 'SCHEDULED') {
      if (new Date(current.scheduledAt).getTime() > Date.now()) { scheduleCampaign(organizationId, campaignId, current.scheduledAt); return; }
      try { await startCampaign(organizationId, campaignId); } catch (err) { await recordEvent(organizationId, campaignId, null, 'SCHEDULE_ERROR', { message: err.message }); }
    }
  }, Math.min(delayMs, 2147483647));
  timer.unref?.();
  scheduledTimers.set(campaignId, timer);
}

async function resumeScheduledCampaigns() {
  const campaigns = await prisma.callCampaign.findMany({ where: { status: 'SCHEDULED', scheduledAt: { not: null } }, select: { id: true, organizationId: true, scheduledAt: true } });
  for (const campaign of campaigns) scheduleCampaign(campaign.organizationId, campaign.id, campaign.scheduledAt);
}

async function resumeRunningCampaigns() {
  const interruptedDirectCalls = await prisma.callDirectRecord.findMany({
    where: { status: { in: ['STARTING', 'RINGING', 'CONNECTED', 'PLAYING'] } },
    select: { id: true, status: true, answeredAt: true, startedAt: true }
  });
  for (const record of interruptedDirectCalls) {
    const finishedAt = new Date();
    const durationSeconds = record.answeredAt ? Math.max(0, Math.round((finishedAt.getTime() - record.answeredAt.getTime()) / 1000)) : 0;
    await prisma.callDirectRecord.update({
      where: { id: record.id },
      data: {
        status: 'FAILED',
        finishedAt,
        durationSeconds,
        endedReason: 'SERVER_RESTARTED',
        errorCode: 'SERVER_RESTARTED',
        errorMessage: 'El servidor se reinició antes de confirmar el resultado de la llamada'
      }
    });
  }
  const interrupted = await prisma.callAttempt.findMany({ where: { status: { in: ['STARTING', 'RINGING', 'CONNECTED', 'PLAYING'] } }, select: { id: true, campaignId: true, campaignContactId: true } });
  for (const attempt of interrupted) {
    await prisma.callAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED', errorCode: 'WORKER_RESTARTED', errorMessage: 'El worker se reinició antes de confirmar el resultado' } });
    await prisma.callCampaignRecipient.updateMany({ where: { id: attempt.campaignContactId, status: { in: ['STARTING', 'RINGING', 'CONNECTED', 'PLAYING'] } }, data: { status: 'RETRY_PENDING', finalResult: 'WORKER_RESTARTED', nextAttemptAt: new Date() } }).catch(() => {});
  }
  await prisma.callCampaignRecipient.updateMany({
    where: { status: 'QUEUED', campaign: { status: 'RUNNING' } },
    data: { status: 'PENDING' }
  });
  const running = await prisma.callCampaign.findMany({ where: { status: 'RUNNING' }, select: { id: true, organizationId: true, accountId: true } });
  for (const campaign of running) {
    accountLocks.add(campaign.accountId);
    runWorker(campaign.organizationId, campaign.id);
  }
}

async function shutdown() {
  stopping = true;
  for (const item of directCalls.values()) { if (!item.finishedAt) item.call.end('server_shutdown'); }
  for (const call of activeCalls.values()) call.end('server_shutdown');
  await Promise.all([...directCalls.values()].map(item => item.finishedPromise));
  for (const timer of scheduledTimers.values()) clearTimeout(timer);
  scheduledTimers.clear();
  await callProvider.shutdown();
}

module.exports = {
  providerState,
  sanitizeAccount,
  sanitizeAudio,
  sanitizeCampaign,
  getCounts,
  findCampaign,
  startCampaign,
  startDirectCall,
  bindDirectAudio,
  getDirectCall,
  endDirectCall,
  pauseCampaign,
  cancelCampaign,
  closeAccount: callProvider.closeAccount,
  scheduleCampaign,
  resumeScheduledCampaigns,
  resumeRunningCampaigns,
  shutdown
};
