const express = require('express');
const { requirePermission } = require('../lib/permissions');
const multer = require('multer');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { saveFile, resolvePath, deleteFile } = require('../lib/storage');
const { extensionFor, safeDownloadName } = require('../lib/attachments');
const { contactAvatarUrlFor } = require('../lib/avatars');
const { csvCell } = require('../lib/csv');
const { createCallCampaignSchema } = require('../validation/call.validation');
const whatsapp = require('../lib/whatsapp');
const calls = require('../lib/callCampaigns');
const { isAcceptableAudio, normalizeCallAudio } = require('../lib/callAudioConvert');
const tts = require('../lib/tts');

const router = express.Router();
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!isAcceptableAudio(file)) return cb(new HttpError(400, 'Formato no soportado. Subí un audio MP3, WAV, M4A, OGG, OPUS, AAC o AMR'));
    cb(null, true);
  }
});

const CAMPAIGN_INCLUDE = { account: true, audio: true, createdBy: { select: { id: true, name: true } }, survey: { include: { options: true } } };

router.use(requireAuth, requireOrgContext);
router.use(requirePermission('calls'));

function currentAccountStatus(organizationId, account) {
  const status = whatsapp.getStatus(organizationId);
  if (status.status === 'connected') return 'CONNECTED';
  if (status.status === 'qr') return 'WAITING_AUTH';
  if (status.status === 'connecting') return 'RECONNECTING';
  if (status.status === 'disconnected') return 'DISCONNECTED';
  return account?.status || 'DISCONNECTED';
}

async function accountList(organizationId) {
  const accounts = await prisma.callAccount.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
  const status = whatsapp.getStatus(organizationId);
  return accounts.map((account) => calls.sanitizeAccount(account, currentAccountStatus(organizationId, account))).map((account) => ({
    ...account,
    qr: account.status === 'WAITING_AUTH' ? status.qr : null
  }));
}

async function writeCallAudit({ organizationId, campaignId = null, userId, action, entityType, entityId = null, details = null }) {
  await prisma.callAuditLog.create({ data: { organizationId, campaignId, userId, action, entityType, entityId, details } });
}

router.get('/provider', (_req, res) => res.json({ provider: calls.providerState() }));

router.get('/accounts', async (req, res, next) => {
  try {
    res.json({ accounts: await accountList(req.auth.organizationId), provider: calls.providerState() });
  } catch (err) { next(err); }
});

router.post('/accounts/connect', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
      const status = await whatsapp.connect(req.auth.organizationId, { fresh: true });
    const account = await prisma.callAccount.findFirst({ where: { organizationId: req.auth.organizationId }, orderBy: { createdAt: 'asc' } });
    const saved = account
      ? await prisma.callAccount.update({ where: { id: account.id }, data: { phoneNumber: status.phone || account.phoneNumber, status: status.status === 'connected' ? 'CONNECTED' : status.status === 'qr' ? 'WAITING_AUTH' : 'RECONNECTING', sessionReference: whatsapp.getSessionReference(req.auth.organizationId), lastError: null } })
      : await prisma.callAccount.create({ data: { organizationId: req.auth.organizationId, name: req.body?.name || 'WhatsApp principal', phoneNumber: status.phone, status: status.status === 'connected' ? 'CONNECTED' : status.status === 'qr' ? 'WAITING_AUTH' : 'RECONNECTING', sessionReference: whatsapp.getSessionReference(req.auth.organizationId), createdByUserId: req.auth.userId } });
    await writeCallAudit({ organizationId: req.auth.organizationId, userId: req.auth.userId, action: 'call.account.connect', entityType: 'CallAccount', entityId: saved.id });
    res.json({ account: calls.sanitizeAccount(saved, currentAccountStatus(req.auth.organizationId, saved)), status, provider: calls.providerState() });
  } catch (err) { next(err); }
});

router.post('/accounts/:id/disconnect', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
      const account = await prisma.callAccount.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
      if (!account) throw new HttpError(404, 'Cuenta de llamadas no encontrada');
      await calls.closeAccount(account.id);
      await whatsapp.disconnect(req.auth.organizationId);
    const updated = await prisma.callAccount.update({ where: { id: account.id }, data: { status: 'DISCONNECTED', phoneNumber: account.phoneNumber } });
    await writeCallAudit({ organizationId: req.auth.organizationId, userId: req.auth.userId, action: 'call.account.disconnect', entityType: 'CallAccount', entityId: account.id });
    res.json({ account: calls.sanitizeAccount(updated, 'DISCONNECTED') });
  } catch (err) { next(err); }
});

router.post('/direct', requireCsrf, async (req, res, next) => {
  try {
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) throw new HttpError(400, 'Falta seleccionar una conversación');

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: req.auth.organizationId },
      include: { contact: true }
    });
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');
    if (conversation.channel !== 'whatsapp') throw new HttpError(409, 'Solo se pueden iniciar llamadas desde conversaciones de WhatsApp');

    const phoneNumber = String(conversation.contact.phone || '').replace(/[^0-9]/g, '');
    if (!/^\d{7,15}$/.test(phoneNumber)) throw new HttpError(400, 'El contacto no tiene un número de WhatsApp válido');

    const account = await prisma.callAccount.findFirst({ where: { organizationId: req.auth.organizationId }, orderBy: { createdAt: 'asc' } });
    if (!account) throw new HttpError(409, 'No hay una cuenta de llamadas configurada para esta organización');

    const call = await calls.startDirectCall(req.auth.organizationId, account, phoneNumber, {
      contactId: conversation.contact.id,
      conversationId: conversation.id,
      userId: req.auth.userId
    });
    await writeCallAudit({
      organizationId: req.auth.organizationId,
      userId: req.auth.userId,
      action: 'call.direct.started',
      entityType: 'Conversation',
      entityId: conversation.id,
      details: { contactId: conversation.contact.id, phoneNumber, callId: call.callId }
    });
    res.status(202).json({ call });
  } catch (err) { next(err); }
});

router.get('/direct/:id', async (req, res, next) => {
  try {
    const call = calls.getDirectCall(req.auth.organizationId, req.params.id);
    if (!call) throw new HttpError(404, 'Llamada no encontrada o ya expiró');
    res.json({ call });
  } catch (err) { next(err); }
});

router.post('/direct/:id/hangup', requireCsrf, async (req, res, next) => {
  try {
    const call = await calls.endDirectCall(req.auth.organizationId, req.params.id);
    if (!call) throw new HttpError(404, 'Llamada no encontrada o ya expiró');
    await writeCallAudit({ organizationId: req.auth.organizationId, userId: req.auth.userId, action: 'call.direct.hangup', entityType: 'DirectCall', entityId: call.id, details: { callId: call.callId } });
    res.json({ call });
  } catch (err) { next(err); }
});

router.get('/audios', async (req, res, next) => {
  try {
    const audios = await prisma.callAudio.findMany({ where: { organizationId: req.auth.organizationId }, orderBy: { createdAt: 'desc' } });
    res.json({ audios: audios.map(calls.sanitizeAudio) });
  } catch (err) { next(err); }
});

router.get('/audios/ai/status', async (_req, res) => {
  res.json({ tts: tts.status() });
});

router.post('/audios', requireCsrf, audioUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Falta el archivo de audio');
    let normalized;
    try {
      normalized = await normalizeCallAudio(req.file);
    } catch (convertError) {
      throw new HttpError(422, convertError.message || 'No se pudo procesar el audio');
    }
    const storageKey = await saveFile(req.auth.organizationId, normalized.buffer, extensionFor(normalized.mimeType));
    const audio = await prisma.callAudio.create({
      data: {
        organizationId: req.auth.organizationId,
        name: String(req.body?.name || req.file.originalname || 'Audio de llamada').slice(0, 120),
        description: req.body?.description ? String(req.body.description).slice(0, 500) : null,
        storageKey,
        mimeType: normalized.mimeType,
        size: normalized.buffer.length,
        processingStatus: 'READY',
        source: 'UPLOAD',
        createdByUserId: req.auth.userId
      }
    });
    await writeCallAudit({ organizationId: req.auth.organizationId, userId: req.auth.userId, action: 'call.audio.created', entityType: 'CallAudio', entityId: audio.id });
    res.status(201).json({ audio: calls.sanitizeAudio(audio) });
  } catch (err) { next(err); }
});

router.post('/audios/ai/generate', requireCsrf, async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new HttpError(400, 'Escribí el texto que querés convertir en audio');
    const name = String(req.body?.name || 'Audio generado con IA').trim().slice(0, 120) || 'Audio generado con IA';
    const language = String(req.body?.language || 'es-PY').trim().slice(0, 40) || 'es-PY';
    const result = await tts.synthesize({ text, voice: req.body?.voice, language, speed: req.body?.speed });
    const storageKey = await saveFile(req.auth.organizationId, result.buffer, '.mp3');
    const audio = await prisma.callAudio.create({
      data: {
        organizationId: req.auth.organizationId,
        name,
        description: `Generado con IA · ${result.provider}${result.voice ? ` · voz ${result.voice}` : ''}`,
        storageKey,
        mimeType: 'audio/mpeg',
        size: result.buffer.length,
        processingStatus: 'READY',
        source: 'AI',
        provider: result.provider,
        voice: result.voice,
        language,
        createdByUserId: req.auth.userId
      }
    });
    await writeCallAudit({ organizationId: req.auth.organizationId, userId: req.auth.userId, action: 'call.audio.ai_created', entityType: 'CallAudio', entityId: audio.id, details: { provider: result.provider, voice: result.voice, language, characters: text.length } });
    res.status(201).json({ audio: calls.sanitizeAudio(audio) });
  } catch (err) { next(err); }
});

router.patch('/audios/:id', requireCsrf, async (req, res, next) => {
  try {
    const audio = await prisma.callAudio.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!audio) throw new HttpError(404, 'Audio no encontrado');
    const updated = await prisma.callAudio.update({ where: { id: audio.id }, data: { ...(typeof req.body.name === 'string' ? { name: req.body.name.trim().slice(0, 120) } : {}), ...(typeof req.body.description === 'string' ? { description: req.body.description.trim().slice(0, 500) } : {}) } });
    res.json({ audio: calls.sanitizeAudio(updated) });
  } catch (err) { next(err); }
});

router.delete('/audios/:id', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const audio = await prisma.callAudio.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId }, include: { campaigns: { select: { id: true } } } });
    if (!audio) throw new HttpError(404, 'Audio no encontrado');
    if (audio.campaigns.length > 0) throw new HttpError(409, 'No se puede eliminar un audio usado por una campaña');
    await prisma.callAudio.delete({ where: { id: audio.id } });
    await deleteFile(audio.storageKey);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.get('/audios/:id/file', async (req, res, next) => {
  try {
    const audio = await prisma.callAudio.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!audio) throw new HttpError(404, 'Audio no encontrado');
    res.setHeader('Content-Type', audio.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${safeDownloadName(audio.name)}${extensionFor(audio.mimeType)}"`);
    res.sendFile(resolvePath(audio.storageKey), (err) => { if (err && !res.headersSent) next(err); });
  } catch (err) { next(err); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const [campaignsList, grouped, responses, accounts, campaignAttempts, directCalls] = await Promise.all([
      prisma.callCampaign.findMany({ where: { organizationId }, include: CAMPAIGN_INCLUDE, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.callCampaignRecipient.groupBy({ by: ['status'], where: { campaign: { organizationId } }, _count: { _all: true } }),
      prisma.callSurveyResponse.count({ where: { campaign: { organizationId }, status: 'RESPONDED' } }),
      accountList(organizationId),
      prisma.callAttempt.findMany({ where: { campaign: { organizationId } }, select: { status: true, durationSeconds: true } }),
      prisma.callDirectRecord.findMany({ where: { organizationId }, select: { status: true, durationSeconds: true } })
    ]);
    const allCalls = [...campaignAttempts, ...directCalls];
    const stats = { scheduled: 0, queued: 0, inProgress: 0, connected: 0, completed: 0, noAnswer: 0, failed: 0, pendingSurvey: 0, surveyResponses: responses, totalCalls: allCalls.length, totalMinutes: Math.round(allCalls.reduce((sum, item) => sum + (item.durationSeconds || 0), 0) / 60 * 10) / 10, attendedCalls: allCalls.filter((item) => ['CONNECTED', 'PLAYING', 'COMPLETED'].includes(item.status)).length, directCalls: directCalls.length };
    for (const row of grouped) {
      const count = row._count._all;
      if (row.status === 'PENDING' || row.status === 'RETRY_PENDING') stats.scheduled += count;
      if (row.status === 'QUEUED') stats.queued += count;
      if (['STARTING', 'RINGING', 'CONNECTED', 'PLAYING'].includes(row.status)) stats.inProgress += count;
      if (['CONNECTED', 'PLAYING', 'COMPLETED'].includes(row.status)) stats.connected += count;
      if (row.status === 'COMPLETED') stats.completed += count;
      if (row.status === 'NO_ANSWER') stats.noAnswer += count;
      if (row.status === 'FAILED') stats.failed += count;
    }
    stats.pendingSurvey = Math.max(0, (await prisma.callCampaignRecipient.count({ where: { campaign: { organizationId, surveyEnabled: true }, status: 'COMPLETED' } })) - responses);
    res.json({ provider: calls.providerState(), accounts, stats, campaigns: await Promise.all(campaignsList.map(async (campaign) => calls.sanitizeCampaign(campaign, await calls.getCounts(campaign.id)))) });
  } catch (err) { next(err); }
});

router.get('/campaigns', async (req, res, next) => {
  try {
    const list = await prisma.callCampaign.findMany({ where: { organizationId: req.auth.organizationId, ...(req.query.status ? { status: String(req.query.status) } : {}) }, include: CAMPAIGN_INCLUDE, orderBy: { createdAt: 'desc' }, take: 300 });
    res.json({ campaigns: await Promise.all(list.map(async (campaign) => calls.sanitizeCampaign(campaign, await calls.getCounts(campaign.id)))) });
  } catch (err) { next(err); }
});

// Contactos para armar la audiencia de llamadas: nombre, número, etapa CRM, etiquetas y estado de consentimiento.
router.get('/audience', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const contacts = await prisma.contact.findMany({
      where: { organizationId, phone: { not: null } },
      select: {
        id: true, name: true, phone: true, email: true, tags: true, avatarUrl: true,
        callConsentStatus: true, callOptedOutAt: true,
        conversations: { select: { tags: true }, orderBy: { updatedAt: 'desc' }, take: 3 }
      },
      orderBy: [{ name: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 5000
    });
    res.json({
      contacts: contacts.map(({ conversations, ...c }) => ({ ...c, avatarUrl: contactAvatarUrlFor(c.avatarUrl), crmTags: Array.from(new Set(conversations.flatMap((cv) => cv.tags))) }))
    });
  } catch (err) { next(err); }
});

// Registro de consentimiento en bloque. Es una declaración del operador (queda con fecha, usuario y fuente):
// solo supervisores/administradores, nunca sobre contactos que pidieron no ser llamados, y exige confirmación explícita.
router.post('/consent', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.contactIds) ? req.body.contactIds.filter((id) => typeof id === 'string').slice(0, 5000) : [];
    if (ids.length === 0) throw new HttpError(400, 'Seleccioná al menos un contacto');
    if (req.body?.confirm !== true) throw new HttpError(400, 'Tenés que confirmar que estos contactos aceptaron ser llamados');
    const operator = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { name: true } });
    const source = String(req.body?.source || 'Declaración del operador').trim().slice(0, 120);
    const where = { organizationId: req.auth.organizationId, id: { in: ids }, callOptedOutAt: null, NOT: { callConsentStatus: 'GRANTED' } };
    const skippedOptedOut = await prisma.contact.count({ where: { organizationId: req.auth.organizationId, id: { in: ids }, callOptedOutAt: { not: null } } });
    const result = await prisma.contact.updateMany({
      where,
      data: { callConsentStatus: 'GRANTED', callConsentAt: new Date(), callConsentSource: `${source} · ${operator?.name || 'operador'}` }
    });
    await writeCallAudit({ organizationId: req.auth.organizationId, userId: req.auth.userId, action: 'call.consent.granted', entityType: 'Contact', entityId: null, details: { granted: result.count, requested: ids.length, skippedOptedOut, source } });
    res.json({ granted: result.count, skippedOptedOut, alreadyGranted: ids.length - result.count - skippedOptedOut });
  } catch (err) { next(err); }
});

// Sugiere qué acción y qué respuesta automática darle a cada opción de la encuesta.
// Con IA (si está configurada) redacta mensajes a medida; si no, usa textos por defecto según el sentido de la opción.

router.post('/survey/suggest-replies', requireCsrf, async (req, res, next) => {
  try {
    const question = String(req.body?.question || '').slice(0, 300);
    const options = (Array.isArray(req.body?.options) ? req.body.options : []).slice(0, 10)
      .map((o) => ({ key: String(o?.key || '').slice(0, 10), label: String(o?.label || '').slice(0, 120) })).filter((o) => o.key && o.label);
    if (options.length === 0) throw new HttpError(400, 'Agregá al menos una opción');
    const { DEFAULT_REPLIES, guessAction } = require('../lib/callSurveys');
    const replies = options.map((o) => { const action = guessAction(o.label); return { key: o.key, action, replyMessage: DEFAULT_REPLIES[action] }; });
    let usedAi = false;
    const niroAi = require('../lib/niroAi');
    if (niroAi.isConfigured()) {
      try {
        const prompt = `Una empresa de Paraguay hizo una llamada y luego envió por WhatsApp esta encuesta: "${question}". Opciones: ${options.map((o) => `${o.key}) ${o.label}`).join(' | ')}. ` +
          'Redactá, para cada opción, la respuesta automática breve (1 a 2 oraciones), cordial y en español rioplatense, con como máximo un emoji. ' +
          'Si la opción es rechazar, agradecé y confirmá que no se le va a llamar más. Si pide contacto más adelante, confirmá que se lo contactará luego. Si acepta, agradecé y prometé mantenerlo informado. ' +
          'Respondé SOLO un JSON: [{"key":"1","reply":"..."}]';
        const response = await niroAi.chatCompletion([{ role: 'system', content: 'Sos un asistente de atención al cliente. Respondés únicamente JSON válido.' }, { role: 'user', content: prompt }]);
        const match = String(response.content || '').match(/\[[\s\S]*\]/);
        const parsed = match ? JSON.parse(match[0]) : [];
        for (const item of parsed) {
          const target = replies.find((r) => r.key === String(item.key));
          if (target && typeof item.reply === 'string' && item.reply.trim().length >= 5) target.replyMessage = item.reply.trim().slice(0, 500);
        }
        usedAi = parsed.length > 0;
        await require('../lib/aiUsage').recordAiUsage(req.auth.organizationId, require('../lib/aiUsage').KINDS.CHAT_TEST, response.cost).catch(() => {});
      } catch (err) { console.warn('[call-survey] sugerencia con IA falló, se usan textos por defecto:', err.message || err); }
    }
    res.json({ replies, usedAi });
  } catch (err) { next(err); }
});

const CAMPAIGN_MANAGERS = requireRole('OWNER', 'ADMIN', 'SUPERVISOR');

// Contactos que sí se pueden llamar (número válido, con consentimiento, sin exclusión, sin duplicados) y los rechazados con motivo.
async function resolveAudience(organizationId, data) {
  const candidates = await prisma.contact.findMany({
    where: { organizationId, OR: [...(data.contactIds.length ? [{ id: { in: data.contactIds } }] : []), ...(data.tagFilter.length ? [{ tags: { hasSome: data.tagFilter } }] : [])] },
    orderBy: { createdAt: 'asc' }
  });
  const rejected = [];
  const accepted = [];
  const seenPhones = new Set();
  for (const contact of candidates) {
    const phone = String(contact.phone || '').replace(/[^0-9]/g, '');
    let reason = null;
    if (!/^\d{7,15}$/.test(phone)) reason = 'Número inválido o ausente';
    else if (contact.callOptedOutAt) reason = 'Contacto excluido de llamadas';
    else if (contact.callConsentStatus !== 'GRANTED') reason = 'Sin consentimiento registrado';
    else if (seenPhones.has(phone)) reason = 'Número duplicado';
    if (reason) rejected.push({ contactId: contact.id, name: contact.name, phone: contact.phone, reason });
    else { seenPhones.add(phone); accepted.push({ contact, phone }); }
  }
  if (accepted.length === 0) throw new HttpError(400, `No hay contactos autorizados para llamar. Rechazados: ${rejected.length}`);
  return { accepted, rejected };
}

// Valida cuenta, audio y fecha, y arma los campos comunes de crear/editar una campaña.
async function campaignPayload(organizationId, data) {
  const [account, audio] = await Promise.all([
    prisma.callAccount.findFirst({ where: { id: data.accountId, organizationId } }),
    prisma.callAudio.findFirst({ where: { id: data.audioId, organizationId } })
  ]);
  if (!account) throw new HttpError(404, 'Cuenta de llamadas no encontrada');
  if (!audio) throw new HttpError(404, 'Audio de llamadas no encontrado');
  const { accepted, rejected } = await resolveAudience(organizationId, data);
  const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  if (scheduledAt && scheduledAt.getTime() <= Date.now()) throw new HttpError(400, 'La fecha de programación debe estar en el futuro');
  const surveyExpiresAt = data.surveyExpiresAt ? new Date(data.surveyExpiresAt) : null;
  const fields = {
    name: data.name, description: data.description || null, campaignType: data.campaignType,
    accountId: account.id, audioId: audio.id, status: scheduledAt ? 'SCHEDULED' : 'DRAFT', scheduledAt,
    timezone: data.timezone, maxConcurrent: data.maxConcurrent, pauseBetweenSeconds: data.pauseBetweenSeconds,
    maxAttempts: data.maxAttempts, answerTimeoutSeconds: data.answerTimeoutSeconds, retryDelaySeconds: data.retryDelaySeconds,
    allowedFrom: data.allowedFrom || null, allowedTo: data.allowedTo || null, surveyEnabled: data.surveyEnabled,
    surveyQuestion: data.surveyQuestion || null, surveyResponseMethod: data.surveyResponseMethod, surveyExpiresAt
  };
  const recipients = { create: accepted.map(({ contact, phone }) => ({ contactId: contact.id, phoneNumber: phone })) };
  const survey = data.surveyEnabled
    ? { create: { question: data.surveyQuestion, responseMethod: data.surveyResponseMethod, expiresAt: surveyExpiresAt, options: { create: data.surveyOptions.map((option) => ({ optionKey: option.key, optionLabel: option.label, replyMessage: option.replyMessage || null, action: option.action || 'NONE', crmStage: option.crmStage || null })) } } }
    : null;
  return { fields, recipients, survey, scheduledAt, accepted, rejected };
}

router.post('/campaigns', requireCsrf, async (req, res, next) => {
  try {
    const data = createCallCampaignSchema.parse(req.body);
    const organizationId = req.auth.organizationId;
    const { fields, recipients, survey, scheduledAt, accepted, rejected } = await campaignPayload(organizationId, data);
    const campaign = await prisma.callCampaign.create({
      data: { organizationId, ...fields, createdByUserId: req.auth.userId, recipients, ...(survey ? { survey } : {}) },
      include: CAMPAIGN_INCLUDE
    });
    if (scheduledAt) calls.scheduleCampaign(organizationId, campaign.id, scheduledAt);
    await writeCallAudit({ organizationId, userId: req.auth.userId, action: 'call.campaign.created', entityType: 'CallCampaign', entityId: campaign.id, details: { accepted: accepted.length, rejected: rejected.length } });
    res.status(201).json({ campaign: calls.sanitizeCampaign(campaign, await calls.getCounts(campaign.id)), accepted: accepted.length, rejected });
  } catch (err) { next(err); }
});

// Editar: solo campañas que todavía no salieron (borrador o programada). Reemplaza datos, destinatarios y encuesta.
router.patch('/campaigns/:id', CAMPAIGN_MANAGERS, requireCsrf, async (req, res, next) => {
  try {
    const data = createCallCampaignSchema.parse(req.body);
    const organizationId = req.auth.organizationId;
    const existing = await calls.findCampaign(organizationId, req.params.id);
    if (!existing) throw new HttpError(404, 'Campaña de llamadas no encontrada');
    if (!['DRAFT', 'SCHEDULED'].includes(existing.status)) throw new HttpError(409, 'Solo se pueden editar campañas en borrador o programadas. Para repetir una que ya corrió, usá "Relanzar".');
    const { fields, recipients, survey, scheduledAt, accepted, rejected } = await campaignPayload(organizationId, data);
    await prisma.$transaction(async (tx) => {
      await tx.callSurvey.deleteMany({ where: { campaignId: existing.id } });
      await tx.callCampaignRecipient.deleteMany({ where: { campaignId: existing.id } });
      await tx.callCampaign.update({ where: { id: existing.id }, data: { ...fields, recipients, ...(survey ? { survey } : {}) } });
    });
    if (scheduledAt) calls.scheduleCampaign(organizationId, existing.id, scheduledAt); else calls.unscheduleCampaign(existing.id);
    await writeCallAudit({ organizationId, campaignId: existing.id, userId: req.auth.userId, action: 'call.campaign.updated', entityType: 'CallCampaign', entityId: existing.id, details: { accepted: accepted.length, rejected: rejected.length } });
    const updated = await calls.findCampaign(organizationId, existing.id);
    res.json({ campaign: calls.sanitizeCampaign(updated, await calls.getCounts(updated.id)), accepted: accepted.length, rejected });
  } catch (err) { next(err); }
});

// Datos para precargar el asistente al editar o relanzar: encuesta, opciones y destinatarios con su resultado.
router.get('/campaigns/:id/config', async (req, res, next) => {
  try {
    const campaign = await calls.findCampaign(req.auth.organizationId, req.params.id);
    if (!campaign) throw new HttpError(404, 'Campaña de llamadas no encontrada');
    const recipients = await prisma.callCampaignRecipient.findMany({ where: { campaignId: campaign.id }, select: { contactId: true, status: true }, orderBy: { createdAt: 'asc' } });
    res.json({
      campaign: calls.sanitizeCampaign(campaign, await calls.getCounts(campaign.id)),
      survey: campaign.survey ? {
        question: campaign.survey.question,
        options: campaign.survey.options.map((o) => ({ key: o.optionKey, label: o.optionLabel, action: o.action === 'AUTO' ? 'NONE' : o.action, replyMessage: o.replyMessage || '', crmStage: o.crmStage || '' }))
          .sort((a, b) => a.key.localeCompare(b.key, 'es', { numeric: true }))
      } : null,
      recipients
    });
  } catch (err) { next(err); }
});

async function deleteCampaigns(organizationId, userId, ids) {
  const found = await prisma.callCampaign.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, name: true, status: true } });
  const deleted = [];
  const skipped = [];
  for (const campaign of found) {
    if (campaign.status === 'RUNNING') { skipped.push({ id: campaign.id, name: campaign.name, reason: 'Está en curso: cancelala o pausala antes de eliminarla' }); continue; }
    calls.unscheduleCampaign(campaign.id);
    await prisma.callCampaign.delete({ where: { id: campaign.id } });
    deleted.push(campaign.id);
    await writeCallAudit({ organizationId, userId, action: 'call.campaign.deleted', entityType: 'CallCampaign', entityId: campaign.id, details: { name: campaign.name, status: campaign.status } });
  }
  return { deleted, skipped };
}

router.delete('/campaigns/:id', CAMPAIGN_MANAGERS, requireCsrf, async (req, res, next) => {
  try {
    const result = await deleteCampaigns(req.auth.organizationId, req.auth.userId, [req.params.id]);
    if (result.skipped.length) throw new HttpError(409, result.skipped[0].reason);
    if (!result.deleted.length) throw new HttpError(404, 'Campaña de llamadas no encontrada');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Limpieza en lote (bandeja / historial): elimina las campañas elegidas y su historial; las que están en curso se omiten.
router.post('/campaigns/bulk-delete', CAMPAIGN_MANAGERS, requireCsrf, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 500) : [];
    if (!ids.length) throw new HttpError(400, 'Elegí al menos una campaña');
    res.json(await deleteCampaigns(req.auth.organizationId, req.auth.userId, ids));
  } catch (err) { next(err); }
});

router.get('/campaigns/:id', async (req, res, next) => {
  try {
    const campaign = await calls.findCampaign(req.auth.organizationId, req.params.id);
    if (!campaign) throw new HttpError(404, 'Campaña de llamadas no encontrada');
    const [recipients, attempts] = await Promise.all([
      prisma.callCampaignRecipient.findMany({ where: { campaignId: campaign.id }, include: { contact: true }, orderBy: { createdAt: 'asc' }, take: 1000 }),
      prisma.callAttempt.findMany({ where: { campaignId: campaign.id }, include: { campaignContact: { include: { contact: true } }, account: true }, orderBy: { createdAt: 'desc' }, take: 1000 })
    ]);
    res.json({ campaign: calls.sanitizeCampaign(campaign, await calls.getCounts(campaign.id)), recipients, attempts });
  } catch (err) { next(err); }
});

router.post('/campaigns/:id/start', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await calls.startCampaign(req.auth.organizationId, req.params.id);
    await writeCallAudit({ organizationId: req.auth.organizationId, campaignId: campaign.id, userId: req.auth.userId, action: 'call.campaign.started', entityType: 'CallCampaign', entityId: campaign.id });
    res.json({ campaign: calls.sanitizeCampaign(campaign, await calls.getCounts(campaign.id)) });
  } catch (err) { next(err); }
});

router.post('/campaigns/:id/pause', requireCsrf, async (req, res, next) => {
  try {
    const existing = await calls.findCampaign(req.auth.organizationId, req.params.id);
    if (!existing) throw new HttpError(404, 'Campaña de llamadas no encontrada');
    await prisma.callCampaign.update({ where: { id: existing.id }, data: { status: 'PAUSED' } });
    // El worker puede estar terminando una llamada. Esperarlo aquí libera el bloqueo
    // de la cuenta antes de que la UI permita reanudar la campaña inmediatamente.
    const worker = calls.pauseCampaign(existing.id);
    if (worker) await worker.catch(() => {});
    await writeCallAudit({ organizationId: req.auth.organizationId, campaignId: existing.id, userId: req.auth.userId, action: 'call.campaign.paused', entityType: 'CallCampaign', entityId: existing.id });
    const updated = await calls.findCampaign(req.auth.organizationId, existing.id);
    res.json({ campaign: calls.sanitizeCampaign(updated, await calls.getCounts(updated.id)) });
  } catch (err) { next(err); }
});

router.post('/campaigns/:id/resume', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await calls.startCampaign(req.auth.organizationId, req.params.id);
    await writeCallAudit({ organizationId: req.auth.organizationId, campaignId: campaign.id, userId: req.auth.userId, action: 'call.campaign.resumed', entityType: 'CallCampaign', entityId: campaign.id });
    res.json({ campaign: calls.sanitizeCampaign(campaign, await calls.getCounts(campaign.id)) });
  } catch (err) { next(err); }
});

router.post('/campaigns/:id/cancel', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await calls.cancelCampaign(req.auth.organizationId, req.params.id);
    await writeCallAudit({ organizationId: req.auth.organizationId, campaignId: campaign.id, userId: req.auth.userId, action: 'call.campaign.cancelled', entityType: 'CallCampaign', entityId: campaign.id });
    res.json({ campaign: calls.sanitizeCampaign(campaign, await calls.getCounts(campaign.id)) });
  } catch (err) { next(err); }
});

// Limpiar el historial de llamadas directas (las hechas desde el chat). Las que están sonando o en curso se conservan.
router.post('/history/direct/bulk-delete', CAMPAIGN_MANAGERS, requireCsrf, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 1000) : [];
    if (!ids.length) throw new HttpError(400, 'Elegí al menos una llamada');
    const result = await prisma.callDirectRecord.deleteMany({ where: { organizationId: req.auth.organizationId, id: { in: ids }, status: { notIn: ['STARTING', 'RINGING', 'CONNECTED', 'PLAYING'] } } });
    await writeCallAudit({ organizationId: req.auth.organizationId, userId: req.auth.userId, action: 'call.direct.deleted', entityType: 'CallDirectRecord', details: { deleted: result.count, requested: ids.length } });
    res.json({ deleted: result.count, skipped: ids.length - result.count });
  } catch (err) { next(err); }
});

router.get('/campaigns/:id/attempts', async (req, res, next) => {
  try {
    const campaign = await calls.findCampaign(req.auth.organizationId, req.params.id);
    if (!campaign) throw new HttpError(404, 'Campaña de llamadas no encontrada');
    const attempts = await prisma.callAttempt.findMany({ where: { campaignId: campaign.id, ...(req.query.status ? { status: String(req.query.status) } : {}) }, include: { campaignContact: { include: { contact: true } }, account: true }, orderBy: { createdAt: 'desc' }, take: Math.min(1000, Math.max(1, Number(req.query.limit) || 100)) });
    res.json({ attempts });
  } catch (err) { next(err); }
});

router.get('/history', async (req, res, next) => {
  try {
    const [attempts, directCalls] = await Promise.all([prisma.callAttempt.findMany({
      where: { campaign: { organizationId: req.auth.organizationId }, ...(req.query.status ? { status: String(req.query.status) } : {}), ...(req.query.campaignId ? { campaignId: String(req.query.campaignId) } : {}) },
      include: { campaign: true, campaignContact: { include: { contact: true } }, account: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(1000, Math.max(1, Number(req.query.limit) || 100))
    }), prisma.callDirectRecord.findMany({
      where: { organizationId: req.auth.organizationId, ...(req.query.status ? { status: String(req.query.status) } : {}) },
      include: { contact: true, conversation: true, account: true, createdBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(1000, Math.max(1, Number(req.query.limit) || 100))
    })]);
    const combined = [
      ...attempts.map((item) => ({ ...item, recordType: 'CAMPAIGN' })),
      ...directCalls.map((item) => ({ ...item, recordType: 'DIRECT' }))
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, Math.min(1000, Math.max(1, Number(req.query.limit) || 100)));
    if (req.query.format === 'csv') {
      const rows = [['Fecha', 'Tipo', 'Contacto', 'Número', 'Campaña', 'Cuenta', 'Estado', 'Duración (segundos)', 'Intento', 'Error'], ...combined.map((item) => [item.createdAt?.toISOString(), item.recordType === 'DIRECT' ? 'Directa' : 'Campaña', item.recordType === 'DIRECT' ? item.contact?.name || 'Sin nombre' : item.campaignContact.contact.name, item.recordType === 'DIRECT' ? item.phoneNumber : item.campaignContact.phoneNumber, item.recordType === 'DIRECT' ? 'Llamada individual' : item.campaign.name, item.account.name, item.status, item.durationSeconds || 0, item.recordType === 'DIRECT' ? '' : item.attemptNumber || '', item.errorMessage || ''])];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="historial-llamadas.csv"');
      return res.send(rows.map((row) => row.map(csvCell).join(',')).join('\n'));
    }
    res.json({ attempts: combined, directCalls, summary: { total: combined.length, direct: directCalls.length, campaigns: attempts.length } });
  } catch (err) { next(err); }
});

router.get('/reports', async (req, res, next) => {
  try {
    const [attempts, directCalls] = await Promise.all([prisma.callAttempt.findMany({ where: { campaign: { organizationId: req.auth.organizationId }, ...(req.query.campaignId ? { campaignId: String(req.query.campaignId) } : {}) }, select: { status: true, durationSeconds: true } }), prisma.callDirectRecord.findMany({ where: { organizationId: req.auth.organizationId }, select: { status: true, durationSeconds: true } })]);
    const records = [...attempts, ...directCalls];
    const report = { totalAttempts: records.length, campaignCalls: attempts.length, directCalls: directCalls.length, connected: records.filter((item) => ['CONNECTED', 'PLAYING', 'COMPLETED'].includes(item.status)).length, noAnswer: records.filter((item) => item.status === 'NO_ANSWER').length, failed: records.filter((item) => item.status === 'FAILED').length, cancelled: records.filter((item) => item.status === 'CANCELLED').length, totalDurationSeconds: records.reduce((sum, item) => sum + (item.durationSeconds || 0), 0) };
    report.connectionRate = report.totalAttempts ? Math.round((report.connected / report.totalAttempts) * 10000) / 100 : 0;
    report.averageConnectedSeconds = report.connected ? Math.round(report.totalDurationSeconds / report.connected) : 0;
    res.json({ report });
  } catch (err) { next(err); }
});

router.get('/surveys/:id/responses', async (req, res, next) => {
  try {
    const survey = await prisma.callSurvey.findFirst({ where: { id: req.params.id, campaign: { organizationId: req.auth.organizationId } }, include: { responses: { include: { contact: true }, orderBy: { respondedAt: 'desc' } } } });
    if (!survey) throw new HttpError(404, 'Encuesta no encontrada');
    res.json({ responses: survey.responses });
  } catch (err) { next(err); }
});

module.exports = router;
