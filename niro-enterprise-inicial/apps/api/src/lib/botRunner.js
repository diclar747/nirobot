// Un solo lugar donde "corre" el bot para un mensaje entrante, sin importar el canal (WhatsApp o widget web).
// Antes esta lógica estaba copiada tres veces y no hacía lo mismo en cada copia: en el PRIMER mensaje de una
// conversación no se avisaba la derivación a un agente ni se usaba la IA.
const { prisma } = require('./prisma');
const { runBotFlow, conversationUpdateData } = require('./botFlow');
const { CONVERSATION_INCLUDE, MESSAGE_INCLUDE, sanitizeConversation, sanitizeMessage, sendBotMessage } = require('./conversations');
const { emitToOrg } = require('./realtime');
const aiBot = require('./aiBot');

/**
 * Corre el flujo para un mensaje y aplica todo lo que decida: etiquetas y etapa CRM, derivación al área o al
 * agente (con su aviso), respuestas del bot y respuesta de IA.
 * @param {function(string): Promise<any>} [deliver] envía el texto al cliente por su canal (WhatsApp). El widget
 *   no lo necesita: el mensaje guardado ya le llega por el socket.
 * @returns {Promise<{result: object, conversation: object}|null>} null si el bot no interviene.
 */
async function handleBotTurn({ organizationId, conversation, contact, content = '', isNewConversation = false, settings, organizationName = null, deliver = null }) {
  if (!settings) return null;
  // Lo último que el bot le dijo a esta persona, si fue hace poco: distingue "recién llega" de "está contestando el menú".
  const RECENT_BOT_REPLY_MS = 2 * 60 * 60 * 1000;
  const previous = await prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: 'OUTBOUND', senderUserId: null, createdAt: { gte: new Date(Date.now() - RECENT_BOT_REPLY_MS) } },
    orderBy: { createdAt: 'desc' },
    select: { content: true }
  }).catch(() => null);
  const result = runBotFlow(settings.botFlow, { content, contact, conversation, isNewConversation, lastBotReply: previous?.content || '' });
  if (!result) return null;

  let updated = conversation;
  const flowData = conversationUpdateData(conversation, result);
  if (Object.keys(flowData).length > 0) {
    updated = await prisma.conversation.update({ where: { id: conversation.id }, data: flowData, include: CONVERSATION_INCLUDE });
  }

  // Guarda la respuesta y la manda por el canal. El id que devuelve WhatsApp se guarda en el mismo mensaje: sin eso,
  // cuando WhatsApp devuelve el eco del mensaje enviado se guardaba otra vez y la respuesta aparecía duplicada en el chat.
  const say = async (text, kind) => {
    const message = await sendBotMessage(conversation.id, organizationId, text, kind);
    if (!deliver) return;
    const waMessageId = await deliver(text).catch((err) => {
      console.error('[bot] no se pudo enviar la respuesta:', err.message || err);
      return null;
    });
    if (!waMessageId || !message) return;
    const updated = await prisma.message.update({ where: { id: message.id }, data: { waMessageId, deliveryStatus: 'sent' }, include: MESSAGE_INCLUDE }).catch(() => null);
    if (updated) emitToOrg(organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(updated) });
  };

  for (const reply of result.replies) await say(reply, 'bot');

  // Derivación: se avisa al agente o al área (nota de transferencia + notificación push).
  if (result.conversation && result.conversation.handoff) {
    await require('./botHandoff').announceHandoff({ organizationId, conversation: updated });
  }

  if (result.useAi && aiBot.shouldReply(updated, settings)) {
    const aiSettings = result.aiPrompt ? { ...settings, systemPrompt: `${settings.systemPrompt || ''} ${result.aiPrompt}`.trim() } : settings;
    const reply = await aiBot.generateReply(conversation.id, aiSettings, organizationName);
    if (reply && reply.content) await say(reply.content, 'ai');
  }

  emitToOrg(organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
  return { result, conversation: updated };
}

module.exports = { handleBotTurn };
