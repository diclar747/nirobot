// Derivación del bot a una persona: avisa al agente (o al área) y, cuando acepta, saluda al cliente en su nombre.
const { prisma } = require('./prisma');
const push = require('./push');
const { emitToUser, emitToOrg } = require('./realtime');
const { CONVERSATION_INCLUDE, MESSAGE_INCLUDE, sanitizeConversation, broadcastMessage } = require('./conversations');
const { HANDOFF_TAG } = require('./botFlow');

const TRANSFER_PREFIX = '🔄 [TRANSFERENCIA]: ';

// Deja la nota "[TRANSFERENCIA]" (la misma que ve el agente con los botones Aceptar/Rechazar) y le avisa a quien corresponde.
async function announceHandoff({ organizationId, conversation }) {
  try {
    const full = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: CONVERSATION_INCLUDE });
    if (!full) return;
    const label = full.contact?.name || full.contact?.phone || 'un cliente';
    const destination = full.assignedTo ? `al agente ${full.assignedTo.name}` : full.department ? `al área ${full.department.name}` : 'a la cola general';
    const note = await prisma.message.create({
      data: { conversationId: full.id, senderUserId: null, direction: 'NOTE', content: `${TRANSFER_PREFIX}Niro (bot) derivó la conversación ${destination}.` },
      include: MESSAGE_INCLUDE
    });
    broadcastMessage(organizationId, full.id, note);

    let targets;
    if (full.assignedToId) targets = [full.assignedToId];
    else {
      const { seeing } = await require('./chatAccess').agentAudience(organizationId, full);
      const managers = await prisma.user.findMany({ where: { organizationId, active: true, role: { in: ['OWNER', 'ADMIN', 'SUPERVISOR'] } }, select: { id: true } });
      targets = [...new Set([...seeing, ...managers.map((m) => m.id)])];
    }
    const payload = sanitizeConversation(full);
    for (const userId of targets) emitToUser(userId, 'transfer:incoming', { conversation: payload, fromAgent: 'Niro (bot)', note: null });
    await Promise.all(targets.map((userId) => push.sendToAgent(organizationId, userId, {
      title: '🔔 Un cliente quiere hablar con vos',
      body: `${label}${full.department ? ` — ${full.department.name}` : ''}`,
      url: `/inbox?conversation=${full.id}`,
      tag: `conversation-${full.id}`
    })));
  } catch (err) {
    console.error('[bot] no se pudo avisar la derivación:', err.message || err);
  }
}

// Cuando el agente acepta un chat derivado por el bot, le escribe al cliente como si fuera él.
async function sendAgentWelcome({ organizationId, conversationId, agent }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: CONVERSATION_INCLUDE });
  if (!conversation || !Array.isArray(conversation.tags) || !conversation.tags.includes(HANDOFF_TAG)) return null;
  const alreadyGreeted = await prisma.message.count({ where: { conversationId, senderUserId: agent.id, direction: 'OUTBOUND' } });
  if (alreadyGreeted > 0) return null;
  const firstName = String(agent.name || '').trim().split(/\s+/)[0] || 'tu asesor';
  const area = conversation.department?.name;
  const content = `¡Bienvenido/a! Soy ${firstName}${area ? ` del área de ${area}` : ''}. ¿En qué puedo ayudarte?`;
  const phone = conversation.contact?.phone;
  const viaWhatsapp = conversation.channel === 'whatsapp' && phone;
  const message = await prisma.message.create({
    data: { conversationId, senderUserId: agent.id, direction: 'OUTBOUND', content, ...(viaWhatsapp ? { deliveryStatus: 'pending' } : {}) },
    include: MESSAGE_INCLUDE
  });
  broadcastMessage(organizationId, conversationId, message);
  if (viaWhatsapp) {
    require('./whatsapp').sendText(organizationId, phone, content)
      .then((waMessageId) => waMessageId && prisma.message.update({ where: { id: message.id }, data: { waMessageId }, include: MESSAGE_INCLUDE }))
      .then((withId) => withId && emitToOrg(organizationId, 'message:updated', { conversationId, message: require('./conversations').sanitizeMessage(withId) }))
      .catch((err) => console.error('[bot] saludo del agente no se envió:', err.message || err));
  }
  return message;
}

module.exports = { announceHandoff, sendAgentWelcome, TRANSFER_PREFIX };
