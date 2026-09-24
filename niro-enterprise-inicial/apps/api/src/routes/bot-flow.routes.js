const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { botFlowSchema, botFlowTestSchema } = require('../validation/org.validation');
const { defaultBotFlow, normalizeFlow, runBotFlow, conversationUpdateData, HANDOFF_TAG } = require('../lib/botFlow');
const aiBot = require('../lib/aiBot');
const niroAi = require('../lib/niroAi');
const { KINDS, recordAiUsage } = require('../lib/aiUsage');

const router = express.Router();

router.use(requireAuth, requireOrgContext);
router.use(requirePermission('bot'));

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

router.patch('/', requireCsrf, async (req, res, next) => {
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

// Simulador del constructor: corre el flujo igual que en producción, pero sin tocar ninguna conversación real.
// Devuelve, además de las respuestas: el estado de la conversación simulada, lo que el bot hizo (derivar, CRM,
// etiquetas) y el recorrido paso a paso de los bloques, para poder depurar el flujo.
router.post('/test', requireCsrf, async (req, res, next) => {
  try {
    const data = botFlowTestSchema.parse(req.body);
    const settings = await getSettings(req.auth.organizationId);
    const savedFlow = settings.botFlow && Array.isArray(settings.botFlow.nodes) ? settings.botFlow : defaultBotFlow();
    const flow = normalizeFlow({ ...(data.flow || savedFlow), enabled: true, published: true });

    const state = data.state || { started: false, tags: [], assignedToId: null, departmentId: null };
    const isNewConversation = !state.started;
    const conversation = { id: 'simulacion', tags: state.tags || [], assignedToId: state.assignedToId || null, departmentId: state.departmentId || null, status: 'OPEN' };
    const contact = { name: 'María González', phone: '+595 981 123 456' };

    const result = runBotFlow(flow, { content: data.message, contact, conversation, isNewConversation, lastBotReply: state.lastBotReply || '' });

    // Sin resultado: o el chat ya está en manos del equipo, o ningún bloque respondió.
    if (!result) {
      const handedOff = conversation.assignedToId || (conversation.tags || []).includes(HANDOFF_TAG);
      return res.json({
        replies: [],
        actions: {},
        trace: [],
        usedAi: false,
        aiConfigured: niroAi.isConfigured(),
        silent: true,
        silentReason: handedOff ? 'handoff' : 'no-match',
        state: { ...state, started: true, lastBotReply: '' }
      });
    }

    let aiReply = null;
    if (result.useAi) {
      if (!niroAi.isConfigured()) {
        aiReply = 'La IA está configurada en el flujo, pero falta la API key de Niro IA en el servidor.';
      } else {
        const systemPrompt = [aiBot.buildSystemPrompt(settings, settings.organization?.name || null), result.aiPrompt].filter(Boolean).join(' ');
        const response = await niroAi.chatCompletion([{ role: 'system', content: systemPrompt }, { role: 'user', content: data.message }]);
        aiReply = response.content || null;
        await recordAiUsage(req.auth.organizationId, KINDS.CHAT_TEST, response.cost);
      }
    }

    // Estado siguiente: las mismas reglas que se aplicarían a la conversación real (etiquetas, derivación, etapa).
    const applied = conversationUpdateData(conversation, result);
    const nextState = {
      started: true,
      lastBotReply: [...(result.replies || [])].pop() || '',
      tags: Array.isArray(applied.tags) ? applied.tags : conversation.tags,
      assignedToId: applied.assignedToId || conversation.assignedToId || null,
      departmentId: applied.departmentId || conversation.departmentId || null
    };

    const actions = result.conversation || {};
    const [department, agent] = await Promise.all([
      actions.departmentId ? prisma.department.findFirst({ where: { id: String(actions.departmentId), organizationId: req.auth.organizationId }, select: { name: true } }) : null,
      actions.assignedToId ? prisma.user.findFirst({ where: { id: String(actions.assignedToId), organizationId: req.auth.organizationId }, select: { name: true } }) : null
    ]);

    const titles = new Map(flow.nodes.map((node) => [node.id, { title: node.title, type: node.type }]));
    res.json({
      replies: [...(result.replies || []), ...(aiReply ? [aiReply] : [])],
      actions,
      handoff: Boolean(actions.handoff),
      departmentName: department?.name || null,
      agentName: agent?.name || null,
      crmStage: actions.crmStage || null,
      tags: Array.isArray(actions.tags) ? actions.tags : [],
      trace: (result.visited || []).map((id) => ({ id, title: titles.get(id)?.title || id, type: titles.get(id)?.type || 'node' })),
      usedAi: Boolean(result.useAi),
      aiConfigured: niroAi.isConfigured(),
      silent: false,
      state: nextState
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
