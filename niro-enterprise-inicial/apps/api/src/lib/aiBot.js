// Bot conversacional con IA: arma el contexto de la conversación y pide la respuesta a Niro IA.
//
// Reglas de silencio (para que la IA nunca pise a una persona):
//   - Si la organización tiene la IA apagada, no responde.
//   - Si no hay NIRO_AI_API_KEY configurada, no responde.
//   - Si un agente humano ya tomó la conversación (assignedToId), no responde.
//   - Si la conversación está resuelta o cerrada, no responde.

const { prisma } = require('./prisma');
const niroAi = require('./niroAi');
const { KINDS, recordAiUsage } = require('./aiUsage');

const HISTORY_LIMIT = 14;
const MAX_REPLY_CHARS = 1200;

const DEFAULT_PERSONA =
  'Sos el asistente virtual de atención al cliente de la empresa por WhatsApp. ' +
  'Respondé en español rioplatense, con mensajes cortos y claros (2 a 4 oraciones), sin markdown. ' +
  'Si no sabés algo o te piden un precio, condición o dato que no tenés, decilo y ofrecé pasar la conversación a un agente humano. ' +
  'Nunca inventes precios, plazos ni stock.';

function aiAvailable(settings) {
  return !!(settings && settings.aiEnabled) && niroAi.isConfigured();
}

function shouldReply(conversation, settings) {
  if (!aiAvailable(settings)) return false;
  if (!conversation) return false;
  if (conversation.assignedToId) return false;
  if (conversation.status === 'RESOLVED' || conversation.status === 'CLOSED') return false;
  return true;
}

function buildSystemPrompt(settings, organizationName) {
  const parts = [];
  const custom = settings && typeof settings.systemPrompt === 'string' ? settings.systemPrompt.trim() : '';
  parts.push(custom || DEFAULT_PERSONA);
  if (organizationName) parts.push(`Trabajás para la empresa "${organizationName}".`);

  const options = settings && Array.isArray(settings.menuOptions) ? settings.menuOptions : [];
  if (options.length > 0) {
    const labels = options.map((opt, idx) => `${opt.key || idx + 1}) ${opt.label}`).join(', ');
    parts.push(
      `La empresa tiene estas áreas de derivación: ${labels}. ` +
        'Si el cliente necesita una de ellas, invitalo a responder con ese número para que lo atienda esa área.'
    );
  }
  parts.push(`Respondé en menos de ${MAX_REPLY_CHARS} caracteres.`);
  return parts.join(' ');
}

// El historial usa únicamente el contenido original del mensaje. Los adjuntos multimedia no
// se transcriben ni se convierten en texto automáticamente dentro del chat.
function messageToTurn(message) {
  if (message.direction === 'NOTE') return null;
  const text = (message.content || '').trim();
  if (!text) return null;
  return { role: message.direction === 'INBOUND' ? 'user' : 'assistant', content: text.slice(0, 2000) };
}

async function buildMessages(conversationId, settings, organizationName) {
  const history = await prisma.message.findMany({
    where: { conversationId, direction: { in: ['INBOUND', 'OUTBOUND'] } },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT
  });

  const turns = history
    .reverse()
    .map(messageToTurn)
    .filter(Boolean);

  return [{ role: 'system', content: buildSystemPrompt(settings, organizationName) }, ...turns];
}

/**
 * Genera la respuesta de la IA para una conversación. Devuelve null si la IA no corresponde,
 * si no hay nada que decir o si Niro IA falló (el error queda logueado, nunca corta el chat).
 */
async function generateReply(conversationId, settings, organizationName) {
  try {
    const messages = await buildMessages(conversationId, settings, organizationName);
    if (messages.length < 2) return null;
    const { content, cost } = await niroAi.chatCompletion(messages);
    if (settings && settings.organizationId) await recordAiUsage(settings.organizationId, KINDS.CHAT, cost);
    if (!content) return null;
    return { content: content.slice(0, MAX_REPLY_CHARS), cost };
  } catch (err) {
    console.error('[ai-bot] no se pudo generar la respuesta:', err.message || err);
    return null;
  }
}

module.exports = { aiAvailable, shouldReply, generateReply, buildSystemPrompt, DEFAULT_PERSONA };
