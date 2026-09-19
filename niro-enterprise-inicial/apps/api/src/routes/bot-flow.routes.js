const express = require('express');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { botFlowSchema, botFlowTestSchema } = require('../validation/org.validation');
const { defaultBotFlow, normalizeFlow, runBotFlow } = require('../lib/botFlow');
const aiBot = require('../lib/aiBot');
const niroAi = require('../lib/niroAi');
const { KINDS, recordAiUsage } = require('../lib/aiUsage');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext);

async function getSettings(organizationId) {
  const settings = await prisma.organizationSettings.findUnique({
    where: { organizationId },
    include: { organization: { select: { name: true, slug: true } } }
  });
  if (!settings) throw new HttpError(404, 'No se encontraron los ajustes de la organización');
  return settings;
}

router.get('/', async (req, res, next) => {
  try {
    const settings = await getSettings(req.auth.organizationId);
    const flow = settings.botFlow && Array.isArray(settings.botFlow.nodes) ? normalizeFlow(settings.botFlow) : defaultBotFlow();
    res.json({ flow, aiEnabled: settings.aiEnabled, aiConfigured: niroAi.isConfigured() });
  } catch (err) {
    next(err);
  }
});

router.patch('/', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
  try {
    const flow = botFlowSchema.parse(req.body.flow || req.body);
    const settings = await prisma.organizationSettings.update({ where: { organizationId: req.auth.organizationId }, data: { botFlow: flow } });
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'bot_flow.updated',
      entityType: 'OrganizationSettings',
      entityId: settings.id,
      metadata: { name: flow.name, enabled: flow.enabled, published: flow.published, nodes: flow.nodes.length }
    });
    res.json({ flow: normalizeFlow(settings.botFlow) });
  } catch (err) {
    next(err);
  }
});

router.post('/test', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
  try {
    const data = botFlowTestSchema.parse(req.body);
    const settings = await getSettings(req.auth.organizationId);
    const savedFlow = settings.botFlow && Array.isArray(settings.botFlow.nodes) ? settings.botFlow : defaultBotFlow();
    const flow = normalizeFlow({ ...(data.flow || savedFlow), enabled: true, published: true });
    const result = runBotFlow(flow, { content: data.message, contact: { name: 'María González', phone: '+595 981 123 456' }, isNewConversation: false });
    let aiReply = null;
    if (result?.useAi) {
      if (!niroAi.isConfigured()) {
        aiReply = 'La IA está configurada en el flujo, pero falta la API key de Niro IA en el servidor.';
      } else {
        const systemPrompt = [aiBot.buildSystemPrompt(settings, settings.organization?.name || null), result.aiPrompt].filter(Boolean).join(' ');
        const response = await niroAi.chatCompletion([{ role: 'system', content: systemPrompt }, { role: 'user', content: data.message }]);
        aiReply = response.content || null;
        await recordAiUsage(req.auth.organizationId, KINDS.CHAT_TEST, response.cost);
      }
    }
    res.json({ replies: [...(result?.replies || []), ...(aiReply ? [aiReply] : [])], actions: result?.conversation || {}, usedAi: Boolean(result?.useAi), aiConfigured: niroAi.isConfigured() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
