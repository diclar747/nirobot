// Agentes IA: proxy autenticado hacia la API de Niro IA (https://niro.cnid.com.py/docs).
// La API key (NIRO_AI_API_KEY) vive solo acá, en el servidor — el frontend nunca la ve.
const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { upload } = require('../middleware/upload');
const niroAi = require('../lib/niroAi');
const aiBot = require('../lib/aiBot');
const { KINDS, recordAiUsage, getUsageSummary } = require('../lib/aiUsage');
const { createAgentSchema, agentChatSchema, testChatSchema } = require('../validation/ai.validation');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext);

// All organizations share one Niro IA platform key, so the provider's agent list is global.
// Ownership is tracked through the audit trail written when an agent is created; an
// organization may only see and talk to agents it created itself.
async function ownedAgentIds(organizationId) {
  const rows = await prisma.auditLog.findMany({
    where: { organizationId, action: 'ai_agent.created', entityId: { not: null } },
    select: { entityId: true }
  });
  return new Set(rows.map((row) => row.entityId));
}

// Every AI call spends money from the shared key. Cap the daily volume per organization.
const AI_DAILY_LIMIT = Math.max(1, Number(process.env.AI_DAILY_LIMIT_PER_ORG || 500));
async function enforceAiQuota(req, _res, next) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const used = await prisma.aiUsageLog.count({ where: { organizationId: req.auth.organizationId, createdAt: { gte: since } } });
    if (used >= AI_DAILY_LIMIT) return next(new HttpError(429, 'Se alcanzó el límite diario de uso de IA de tu organización'));
    next();
  } catch (err) {
    next(err);
  }
}

// Resumen de uso de la API de Niro IA (cantidad de llamadas y costo, por tipo). El costo se
// muestra desglosado por tipo porque la unidad no es necesariamente comparable entre categorías.
router.get('/usage/summary', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const summary = await getUsageSummary(req.auth.organizationId, days);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// Estado de la integración: si hay API key configurada en el servidor y si la organización
// tiene el bot de IA habilitado. El frontend usa esto para mostrar avisos en vez de romper.
router.get('/status', async (req, res, next) => {
  try {
    const settings = await prisma.organizationSettings.findUnique({ where: { organizationId: req.auth.organizationId } });
    res.json({
      configured: niroAi.isConfigured(),
      aiEnabled: !!(settings && settings.aiEnabled),
      systemPrompt: (settings && settings.systemPrompt) || '',
      defaultPersona: aiBot.DEFAULT_PERSONA
    });
  } catch (err) {
    next(err);
  }
});

// Prueba rápida del bot de WhatsApp/widget con el prompt actual de la organización, sin
// necesidad de una conversación real. Útil desde Ajustes para validar el tono antes de activarlo.
router.post('/chat/test', enforceAiQuota, requirePermission('aiAgents'), requireCsrf, async (req, res, next) => {
  try {
    const data = testChatSchema.parse(req.body);
    const settings = await prisma.organizationSettings.findUnique({
      where: { organizationId: req.auth.organizationId },
      include: { organization: { select: { name: true } } }
    });
    const systemPrompt = aiBot.buildSystemPrompt(settings, settings?.organization?.name || null);
    const { content, cost } = await niroAi.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: data.message }
    ]);
    await recordAiUsage(req.auth.organizationId, KINDS.CHAT_TEST, cost);
    res.json({ reply: content, cost });
  } catch (err) {
    next(err);
  }
});

router.get('/agents', async (req, res, next) => {
  try {
    const [agents, owned] = await Promise.all([niroAi.listAgents(), ownedAgentIds(req.auth.organizationId)]);
    res.json({ agents: agents.filter((agent) => owned.has(String(agent.id))) });
  } catch (err) {
    next(err);
  }
});

router.post('/agents', requirePermission('aiAgents'), requireCsrf, async (req, res, next) => {
  try {
    const data = createAgentSchema.parse(req.body);
    const agent = await niroAi.createAgent(data);
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'ai_agent.created',
      entityType: 'AiAgent',
      entityId: (agent && agent.id) || null,
      metadata: { name: data.name, category: data.category || 'CHAT' }
    });
    res.status(201).json({ agent });
  } catch (err) {
    next(err);
  }
});

router.post('/agents/:id/chat', requireCsrf, enforceAiQuota, async (req, res, next) => {
  try {
    const data = agentChatSchema.parse(req.body);
    if (!(await ownedAgentIds(req.auth.organizationId)).has(req.params.id)) throw new HttpError(404, 'Agente no encontrado');
    const { content, cost } = await niroAi.chatWithAgent(req.params.id, data.messages);
    await recordAiUsage(req.auth.organizationId, KINDS.AGENT_CHAT, cost);
    res.json({ reply: content, cost });
  } catch (err) {
    next(err);
  }
});

// OCR / lectura de factura sobre una imagen subida a mano (por ejemplo, para precargar un
// pedido desde la foto de una factura). mode='invoice' devuelve el JSON estructurado.
router.post('/vision/extract', requireCsrf, enforceAiQuota, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Falta el archivo');
    const mode = req.body.mode === 'invoice' ? 'invoice' : 'text';
    const question = req.body.question ? String(req.body.question).slice(0, 500) : undefined;
    const result = await niroAi.visionExtract(req.file.buffer, req.file.originalname, req.file.mimetype, { mode, question });
    await recordAiUsage(req.auth.organizationId, KINDS.VISION, result.cost);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Preguntas y respuestas sobre un PDF con texto seleccionable.
router.post('/documents/analyze', requireCsrf, enforceAiQuota, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Falta el archivo');
    const question = req.body.question ? String(req.body.question).slice(0, 500) : undefined;
    const result = await niroAi.analyzeDocument(req.file.buffer, req.file.originalname, req.file.mimetype, { question });
    await recordAiUsage(req.auth.organizationId, KINDS.DOCUMENT, result.cost);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Transcripción manual de un audio (fuera del flujo de WhatsApp), para probar la integración.
router.post('/audio/transcriptions', requireCsrf, enforceAiQuota, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Falta el archivo');
    const result = await niroAi.transcribeAudio(req.file.buffer, req.file.originalname, req.file.mimetype);
    await recordAiUsage(req.auth.organizationId, KINDS.TRANSCRIPTION, result.cost);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
