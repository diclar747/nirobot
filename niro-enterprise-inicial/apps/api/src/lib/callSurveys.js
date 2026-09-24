const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');

// Respuesta por defecto según la acción de la opción (el operador puede escribir la suya).
const DEFAULT_REPLIES = {
  INTERESTED: '¡Muchas gracias por tu interés! 🙌 Te vamos a mantener informado con más detalles muy pronto.',
  OPT_OUT: 'Gracias por tu respuesta. Entendido: de ahora en más no vas a recibir más llamadas nuestras. ¡Que tengas un excelente día!',
  FOLLOW_UP: '¡Perfecto! Te contactaremos más adelante. Muchas gracias por tu interés.',
  NONE: '¡Muchas gracias por tu respuesta! La tenemos registrada.'
};

// Interpreta el sentido de una opción por su texto (para campañas anteriores, sin acción configurada).
function guessAction(label) {
  const t = String(label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (/^no\b|no gracias|no molest|dar de baja|no llam|no me interesa|dejar de recibir/.test(t)) return 'OPT_OUT';
  if (/mas adelante|luego|despues|otro momento|mas tarde|en otra oportunidad/.test(t)) return 'FOLLOW_UP';
  if (/^si\b|deseo|quiero|me interesa|informacion|acepto/.test(t)) return 'INTERESTED';
  return 'NONE';
}

const STAGE_TAGS = ['Abiertas', 'Pendientes', 'Clientes', 'Interesados', 'Cerradas'];
// Etapa del embudo (CRM) elegida por opción; "Marcar como interesado" sin etapa explícita sigue yendo a Interesados.
const STAGES = {
  abiertas: { tag: 'Abiertas', status: 'OPEN' },
  pendientes: { tag: 'Pendientes', status: 'PENDING' },
  clientes: { tag: 'Clientes', status: null },
  interesados: { tag: 'Interesados', status: null },
  cerradas: { tag: 'Cerradas', status: 'CLOSED' }
};

// Aplica la acción de la opción sobre el contacto (baja de llamadas, interesado en el CRM, seguimiento).
function resolveOption(option) {
  return option.action === 'AUTO' || !option.action ? { ...option, action: guessAction(option.optionLabel) } : option;
}

// Igual que el menú del bot de WhatsApp: si la opción tiene un área o un agente, el chat se deriva al elegirla
// (queda marcado "Derivado", el bot deja de responderle y el equipo lo ve con Aceptar/Rechazar).
async function applyHandoff(organizationId, contact, option) {
  if (!option.departmentId && !option.userId) return;
  const conversation = await prisma.conversation.findFirst({ where: { organizationId, contactId: contact.id, channel: 'whatsapp' }, orderBy: { updatedAt: 'desc' } });
  if (!conversation) return;
  const { HANDOFF_TAG } = require('./botFlow');
  const tags = [...new Set([...(conversation.tags || []), HANDOFF_TAG])].slice(0, 30);
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { tags, status: 'OPEN', ...(option.departmentId ? { departmentId: option.departmentId } : {}), ...(option.userId ? { assignedToId: option.userId } : {}) }
  });
  await require('./botHandoff').announceHandoff({ organizationId, conversation: updated });
}

async function applyOptionAction(organizationId, contact, rawOption) {
  const option = resolveOption(rawOption);
  await applyHandoff(organizationId, contact, option).catch((err) => console.error('[call-survey] derivación falló', err.message || err));
  if (option.action === 'OPT_OUT') {
    await prisma.contact.update({ where: { id: contact.id }, data: { callOptedOutAt: new Date(), callOptOutSource: `Encuesta de llamada: "${option.optionLabel}"`.slice(0, 200) } });
  } else if (option.action === 'INTERESTED' || option.action === 'FOLLOW_UP') {
    const tag = option.action === 'INTERESTED' ? 'interesado' : 'contactar-mas-adelante';
    if (!contact.tags.includes(tag)) await prisma.contact.update({ where: { id: contact.id }, data: { tags: { set: [...contact.tags, tag] } } });
  }
  const stage = STAGES[option.crmStage] || (option.action === 'INTERESTED' ? STAGES.interesados : null);
  if (stage) {
    const conversation = await prisma.conversation.findFirst({ where: { organizationId, contactId: contact.id }, orderBy: { updatedAt: 'desc' } });
    if (conversation) {
      const tags = [...conversation.tags.filter((t) => !STAGE_TAGS.includes(t)), stage.tag];
      const { CONVERSATION_INCLUDE, sanitizeConversation } = require('./conversations');
      const updated = await prisma.conversation.update({ where: { id: conversation.id }, data: { tags, ...(stage.status ? { status: stage.status } : {}) }, include: CONVERSATION_INCLUDE });
      emitToOrg(organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
    }
  }
}

async function sendAutoReply(organizationId, contact, phone, rawOption) {
  const option = resolveOption(rawOption);
  const text = (option.replyMessage && option.replyMessage.trim()) || DEFAULT_REPLIES[option.action] || DEFAULT_REPLIES.NONE;
  try {
    if (await require('./billing').isBlocked(organizationId).catch(() => false)) return null; // plan vencido: no se responde solo
    const whatsapp = require('./whatsapp');
    await whatsapp.sendText(organizationId, phone, text);
    const conversation = await prisma.conversation.findFirst({ where: { organizationId, contactId: contact.id, channel: 'whatsapp' }, orderBy: { updatedAt: 'desc' } });
    if (conversation) await require('./conversations').sendBotMessage(conversation.id, organizationId, text);
    return text;
  } catch (err) {
    console.error('[call-survey] no se pudo enviar la respuesta automática', err.message || err);
    return null;
  }
}

function normalizeAnswer(value) {
  return String(value || '').trim().toLowerCase().replace(/[.)]/g, '');
}

// Una encuesta de llamadas solo "escucha" durante las 24 h siguientes a la llamada. Sin esto, una campaña vieja
// con opciones 1/2/3 se quedaba con TODOS los mensajes numéricos del cliente para siempre y el bot nunca respondía.
const SURVEY_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

async function registerInboundResponse(organizationId, phone, text) {
  if (!phone || !text) return null;
  const surveys = await prisma.callSurvey.findMany({
    where: {
      responseMethod: 'WHATSAPP',
      campaign: { organizationId, status: { in: ['RUNNING', 'PAUSED', 'COMPLETED'] } },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
    },
    include: { options: true, campaign: { select: { id: true, organizationId: true } } }
  });
  const answer = normalizeAnswer(text);
  for (const survey of surveys) {
    const contact = await prisma.contact.findFirst({ where: { organizationId, phone } });
    if (!contact) continue;
    const option = survey.options.find((candidate) => normalizeAnswer(candidate.optionKey) === answer);
    if (!option) continue;
    const recipient = await prisma.callCampaignRecipient.findFirst({
      where: {
        campaignId: survey.campaignId,
        contactId: contact.id,
        status: 'COMPLETED',
        // Solo si la llamada fue hace poco: pasada la ventana, el mensaje es una conversación normal (y contesta el bot).
        updatedAt: { gte: new Date(Date.now() - SURVEY_ANSWER_WINDOW_MS) }
      },
      orderBy: { updatedAt: 'desc' },
      include: { attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } }
    });
    if (!recipient) continue;
    // Una persona responde una sola vez por encuesta: si repite "1", ya no es una respuesta y sigue el flujo normal.
    if (await prisma.callSurveyResponse.findFirst({ where: { surveyId: survey.id, contactId: contact.id } })) continue;
    const response = await prisma.callSurveyResponse.create({
      data: {
        surveyId: survey.id,
        campaignId: survey.campaignId,
        contactId: contact.id,
        attemptId: recipient.attempts[0] ? recipient.attempts[0].id : null,
        responseValue: option.optionKey,
        responseChannel: 'WHATSAPP'
      }
    });
    emitToOrg(organizationId, 'wa-call:survey_response', { campaignId: survey.campaignId, response });
    await applyOptionAction(organizationId, contact, option).catch((err) => console.error('[call-survey] acción falló', err.message || err));
    const replied = await sendAutoReply(organizationId, contact, phone, option);
    return { ...response, autoReply: replied };
  }
  return null;
}

module.exports = { registerInboundResponse, DEFAULT_REPLIES, guessAction };
