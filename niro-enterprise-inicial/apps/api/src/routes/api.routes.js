const express = require('express');
const rateLimit = require('express-rate-limit');
const { upload } = require('../middleware/upload');
const { HttpError } = require('../lib/errors');
const { authenticateApiKey, requireApiScope } = require('../lib/apiKeys');
const {
  apiMessageSchema, apiStatusSchema, apiConversationPatchSchema, apiContactSchema, apiSmsSchema, apiWebhookSchema
} = require('../validation/api.validation');
const { sendApiMessage } = require('../lib/apiMessages');
const statusPosts = require('../lib/statusPosts');
const { statusUpload } = require('../lib/statusMedia');
const { prisma } = require('../lib/prisma');
const { sanitizeConversation, sanitizeMessage, CONVERSATION_INCLUDE, MESSAGE_INCLUDE } = require('../lib/conversations');
const sms = require('../lib/sms');
const webhooks = require('../lib/apiWebhooks');
const { listSessions } = require('../lib/whatsapp');
const { openapi } = require('../lib/openapi');
const { MAX_SIZE, isAllowedMimeType } = require('../lib/attachments');

const router = express.Router();
const configuredRateLimit = Number(process.env.API_RATE_LIMIT || 120);
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number.isFinite(configuredRateLimit) && configuredRateLimit > 0 ? configuredRateLimit : 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.apiAuth?.apiKeyId || req.ip
});

router.get('/', (_req, res) => {
  res.json({ name: openapi.info.title, version: openapi.info.version, docs: '/api/v1/openapi.json', authentication: 'Bearer API key' });
});

router.get('/openapi.json', (_req, res) => {
  res.json(openapi);
});

router.use(authenticateApiKey, apiLimiter);

router.get('/sessions', requireApiScope('sessions:read'), (req, res) => {
  res.json({ organizationId: req.apiAuth.organizationId, sessions: listSessions(req.apiAuth.organizationId) });
});

router.post('/messages', requireApiScope('messages:send'), upload.single('file'), async (req, res, next) => {
  try {
    const raw = { ...req.body };
    const parsed = apiMessageSchema.parse(raw);
    const file = req.file || decodeBase64File(raw.mediaBase64, parsed.mimeType, parsed.fileName);
    const type = raw.type ? parsed.type : (file ? inferType(file.mimetype) : 'text');
    const result = await sendApiMessage({
      organizationId: req.apiAuth.organizationId,
      apiKeyId: req.apiAuth.apiKeyId,
      ...parsed,
      type,
      file,
      mimeType: file ? file.mimetype : parsed.mimeType,
      fileName: file ? file.originalname || parsed.fileName : parsed.fileName
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// Estados de WhatsApp (las "historias" de 24 h). Texto, imagen o video, con la misma audiencia y programación
// que el panel: se comparte lib/statusPosts.createPost.
router.post('/status', requireApiScope('status:send'), statusUpload.single('file'), async (req, res, next) => {
  try {
    const raw = { ...req.body };
    const parsed = apiStatusSchema.parse(raw);
    const file = req.file || decodeBase64File(raw.mediaBase64, parsed.mimeType, parsed.fileName);
    const contentType = raw.contentType ? parsed.contentType : (file ? inferStatusType(file.mimetype) : 'text');
    const { post } = await statusPosts.createPost({
      organizationId: req.apiAuth.organizationId,
      createdByUserId: null,
      data: { ...parsed, contentType },
      file
    });
    res.status(201).json({ status: statusPosts.sanitizePost(post) });
  } catch (err) {
    next(err);
  }
});

// Consultar cómo salió: "processing", "published" (con cuántos contactos), "failed" o "scheduled".
router.get('/status/:id', requireApiScope('status:read'), async (req, res, next) => {
  try {
    const post = await prisma.whatsappStatusPost.findFirst({ where: { id: req.params.id, organizationId: req.apiAuth.organizationId } });
    if (!post) throw new HttpError(404, 'Publicación no encontrada');
    res.json({ status: statusPosts.sanitizePost(post) });
  } catch (err) {
    next(err);
  }
});

// Últimas publicaciones de la organización.
router.get('/status', requireApiScope('status:read'), async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const rows = await prisma.whatsappStatusPost.findMany({
      where: { organizationId: req.apiAuth.organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    res.json({ statuses: rows.map(statusPosts.sanitizePost) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- estado de la cuenta
// Un solo lugar para saber si la línea está conectada y qué permisos tiene la clave.
router.get('/me', (req, res) => {
  const sessions = listSessions(req.apiAuth.organizationId);
  // El estado real de la línea manda; las sesiones listadas son el detalle.
  // Se consulta en el momento (no al importar) para reflejar siempre el estado actual de la línea.
  const status = require('../lib/whatsapp').getStatus(req.apiAuth.organizationId).status;
  const connected = status === 'connected' || sessions.some((session) => session.status === 'connected');
  res.json({
    organizationId: req.apiAuth.organizationId,
    scopes: req.apiAuth.scopes,
    whatsapp: { connected, status, sessions }
  });
});

// ---------------------------------------------------------------- recibir (consultando)
// Mensajes entrantes desde una fecha: la alternativa al webhook para quien prefiere consultar cada tanto.
router.get('/messages', requireApiScope('messages:read'), async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    if (since && Number.isNaN(since.getTime())) throw new HttpError(400, 'El parámetro since debe ser una fecha ISO');
    const direction = ['INBOUND', 'OUTBOUND'].includes(String(req.query.direction || '').toUpperCase())
      ? String(req.query.direction).toUpperCase()
      : { in: ['INBOUND', 'OUTBOUND'] };
    const rows = await prisma.message.findMany({
      where: {
        conversation: { organizationId: req.apiAuth.organizationId },
        direction,
        ...(req.query.conversationId ? { conversationId: String(req.query.conversationId) } : {}),
        ...(since ? { createdAt: { gt: since } } : {})
      },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: limit
    });
    res.json({
      messages: rows.map((row) => ({ ...sanitizeMessage(row), conversationId: row.conversationId })),
      nextSince: rows.length > 0 ? rows[rows.length - 1].createdAt.toISOString() : (since ? since.toISOString() : null)
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- conversaciones
router.get('/conversations', requireApiScope('conversations:read'), async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const status = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'].includes(String(req.query.status || '').toUpperCase())
      ? String(req.query.status).toUpperCase()
      : undefined;
    const rows = await prisma.conversation.findMany({
      where: { organizationId: req.apiAuth.organizationId, ...(status ? { status } : {}) },
      include: CONVERSATION_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      take: limit
    });
    res.json({ conversations: rows.map(sanitizeConversation) });
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:id', requireApiScope('conversations:read'), async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, organizationId: req.apiAuth.organizationId },
      include: CONVERSATION_INCLUDE
    });
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    });
    res.json({ conversation: sanitizeConversation(conversation), messages: messages.reverse().map(sanitizeMessage) });
  } catch (err) {
    next(err);
  }
});

// Cambiar el estado, las etiquetas, el agente o el área de un chat.
router.patch('/conversations/:id', requireApiScope('conversations:write'), async (req, res, next) => {
  try {
    const data = apiConversationPatchSchema.parse(req.body);
    const existing = await prisma.conversation.findFirst({ where: { id: req.params.id, organizationId: req.apiAuth.organizationId } });
    if (!existing) throw new HttpError(404, 'Conversación no encontrada');
    if (data.assignedToId) {
      const user = await prisma.user.findFirst({ where: { id: data.assignedToId, organizationId: req.apiAuth.organizationId, active: true } });
      if (!user) throw new HttpError(404, 'Agente no encontrado');
    }
    if (data.departmentId) {
      const department = await prisma.department.findFirst({ where: { id: data.departmentId, organizationId: req.apiAuth.organizationId } });
      if (!department) throw new HttpError(404, 'Área no encontrada');
    }
    const conversation = await prisma.conversation.update({ where: { id: existing.id }, data, include: CONVERSATION_INCLUDE });
    const payload = sanitizeConversation(conversation);
    require('../lib/realtime').emitToOrg(req.apiAuth.organizationId, 'conversation:updated', { conversation: payload });
    webhooks.emitWebhook(req.apiAuth.organizationId, 'conversation.updated', payload).catch(() => {});
    res.json({ conversation: payload });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- contactos
router.get('/contacts', requireApiScope('contacts:read'), async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const search = String(req.query.search || '').trim();
    const rows = await prisma.contact.findMany({
      where: {
        organizationId: req.apiAuth.organizationId,
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search.replace(/\D/g, '') || search } }] } : {})
      },
      select: { id: true, name: true, phone: true, email: true, tags: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    res.json({ contacts: rows });
  } catch (err) {
    next(err);
  }
});

// Alta o actualización por teléfono: repetir el mismo número no duplica el contacto.
router.post('/contacts', requireApiScope('contacts:write'), async (req, res, next) => {
  try {
    const data = apiContactSchema.parse(req.body);
    const phone = String(data.phone).replace(/[^0-9]/g, '');
    if (!phone) throw new HttpError(400, 'El teléfono debe tener dígitos');
    const existing = await prisma.contact.findFirst({ where: { organizationId: req.apiAuth.organizationId, phone } });
    const contact = existing
      ? await prisma.contact.update({ where: { id: existing.id }, data: { name: data.name ?? existing.name, email: data.email ?? existing.email, tags: data.tags ?? existing.tags } })
      : await prisma.contact.create({ data: { organizationId: req.apiAuth.organizationId, phone, name: data.name || null, email: data.email || null, tags: data.tags || [] } });
    res.status(existing ? 200 : 201).json({ contact: { id: contact.id, name: contact.name, phone: contact.phone, email: contact.email, tags: contact.tags }, created: !existing });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- SMS
router.get('/sms/balance', requireApiScope('sms:read'), async (req, res, next) => {
  try {
    res.json({ balance: await sms.getBalance(req.apiAuth.organizationId), priceGs: sms.PRICE_GS() });
  } catch (err) {
    next(err);
  }
});

// Enviar SMS a uno o varios números. Devuelve el id del envío para consultar cómo salió.
router.post('/sms', requireApiScope('sms:send'), async (req, res, next) => {
  try {
    const data = apiSmsSchema.parse(req.body);
    const list = Array.isArray(data.to) ? data.to : [data.to];
    const { campaign, recipients, invalid } = await sms.createCampaign(req.apiAuth.organizationId, null, {
      name: `API ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      message: data.message,
      stripAccents: data.stripAccents !== false,
      source: 'API',
      recipients: list.map((phone) => ({ phone, name: data.name || null }))
    });
    await sms.assertBalanceFor(req.apiAuth.organizationId, campaign.id);
    await sms.startCampaign(req.apiAuth.organizationId, campaign.id);
    res.status(201).json({ id: campaign.id, recipients, invalid, status: 'SENDING' });
  } catch (err) {
    next(err);
  }
});

router.get('/sms/:id', requireApiScope('sms:read'), async (req, res, next) => {
  try {
    const campaign = await prisma.smsCampaign.findFirst({ where: { id: req.params.id, organizationId: req.apiAuth.organizationId } });
    if (!campaign) throw new HttpError(404, 'Envío no encontrado');
    const messages = await prisma.smsMessage.findMany({
      where: { campaignId: campaign.id },
      select: { phone: true, status: true, errorMessage: true, sentAt: true, deliveredAt: true },
      take: 1000
    });
    res.json({ id: campaign.id, status: campaign.status, createdAt: campaign.createdAt, messages });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- webhooks (recibir en tiempo real)
router.get('/webhooks', requireApiScope('webhooks:manage'), async (req, res, next) => {
  try {
    const rows = await prisma.apiWebhook.findMany({ where: { organizationId: req.apiAuth.organizationId }, orderBy: { createdAt: 'desc' } });
    res.json({ webhooks: rows.map((hook) => webhooks.sanitizeWebhook(hook)), events: webhooks.EVENTS });
  } catch (err) {
    next(err);
  }
});

router.post('/webhooks', requireApiScope('webhooks:manage'), async (req, res, next) => {
  try {
    const data = apiWebhookSchema.parse(req.body);
    const hook = await prisma.apiWebhook.create({
      data: {
        organizationId: req.apiAuth.organizationId,
        apiKeyId: req.apiAuth.apiKeyId,
        url: data.url,
        events: data.events,
        active: data.active !== false,
        secret: webhooks.newSecret()
      }
    });
    // El secreto se muestra una sola vez: con él se valida la firma X-Niro-Signature de cada aviso.
    res.status(201).json({ webhook: webhooks.sanitizeWebhook(hook, { includeSecret: true }) });
  } catch (err) {
    next(err);
  }
});

router.delete('/webhooks/:id', requireApiScope('webhooks:manage'), async (req, res, next) => {
  try {
    const hook = await prisma.apiWebhook.findFirst({ where: { id: req.params.id, organizationId: req.apiAuth.organizationId } });
    if (!hook) throw new HttpError(404, 'Webhook no encontrado');
    await prisma.apiWebhook.delete({ where: { id: hook.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

function inferStatusType(mimeType) {
  if (!mimeType) return 'text';
  if (String(mimeType).startsWith('video/')) return 'video';
  if (String(mimeType).startsWith('image/')) return 'image';
  return 'text';
}

function inferType(mimeType) {
  if (!mimeType) return 'text';
  if (mimeType === 'image/webp') return 'sticker';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

function decodeBase64File(value, mimeType, fileName) {
  if (!value) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'mediaBase64 debe ser texto base64');
  const clean = value.replace(/^data:[^;]+;base64,/, '');
  let buffer;
  try {
    buffer = Buffer.from(clean, 'base64');
  } catch {
    throw new HttpError(400, 'mediaBase64 no es válido');
  }
  if (!buffer.length || buffer.length > MAX_SIZE) throw new HttpError(400, 'mediaBase64 vacío o supera 15 MB');
  if (!mimeType || !isAllowedMimeType(mimeType)) throw new HttpError(400, 'mimeType no permitido para mediaBase64');
  return { buffer, mimetype: mimeType, originalname: fileName || 'archivo' };
}

module.exports = router;
