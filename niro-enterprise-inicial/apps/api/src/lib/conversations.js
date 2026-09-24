const { prisma } = require('./prisma');
const { emitToOrg, emitToConversation } = require('./realtime');
const { sanitizeAttachment } = require('./attachments');
const { contactAvatarUrlFor } = require('./avatars');

const CONVERSATION_INCLUDE = {
  contact: true,
  department: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true, email: true } }
};

const MESSAGE_INCLUDE = {
  sender: { select: { id: true, name: true } },
  attachment: true
};

function sanitizeConversation(conversation) {
  return {
    id: conversation.id,
    subject: conversation.subject,
    status: conversation.status,
    priority: conversation.priority,
    channel: conversation.channel,
    tags: conversation.tags,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    contact: conversation.contact ? { ...conversation.contact, avatarUrl: contactAvatarUrlFor(conversation.contact.avatarUrl) } : null,
    department: conversation.department,
    assignedTo: conversation.assignedTo
  };
}

function sanitizeMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    content: message.content,
    contentType: message.contentType,
    deliveryStatus: message.deliveryStatus,
    senderKind: message.senderKind || null,
    viaCampaign: Boolean(message.campaignId),
    viaApi: Boolean(message.apiKeyId),
    waMessageId: message.waMessageId,
    quotedMessageId: message.quotedMessageId,
    quotedPreview: message.quotedPreview,
    quotedSender: message.quotedSender,
    transcription: message.transcription || null,
    reactions: Array.isArray(message.reactions) ? message.reactions : [],
    staffOnly: Boolean(message.staffOnly),
    createdAt: message.createdAt,
    sender: message.sender ? { id: message.sender.id, name: message.sender.name } : null,
    attachment: sanitizeAttachment(message.attachment)
  };
}

// Broadcasts a message to the org's staff (agents/admins in their Inbox) and, unless it's an
// internal note, to the widget visitor's own conversation room. Notes must never reach the
// public/widget side — that boundary is enforced right here, at the single choke point every
// message send (internal or widget) passes through.
function broadcastMessage(organizationId, conversationId, message) {
  const payload = sanitizeMessage(message);
  // Integraciones externas: un mensaje entrante es el evento más pedido de la API.
  if (message.direction === 'INBOUND') {
    require('./apiWebhooks').emitWebhook(organizationId, 'message.received', { conversationId, message: payload }).catch(() => {});
  }
  // Las notas internas de administración no llegan a los agentes ni al chat del cliente.
  if (message.staffOnly) {
    require('./realtime').emitToOrgStaff(organizationId, 'message:new', { conversationId, message: payload });
    return payload;
  }
  emitToOrg(organizationId, 'message:new', { conversationId, message: payload });
  if (message.direction !== 'NOTE') {
    emitToConversation(conversationId, 'message:new', { conversationId, message: payload });
  }
  return payload;
}

async function sendBotMessage(conversationId, organizationId, content, kind = 'bot') {
  const message = await prisma.message.create({
    data: { conversationId, senderUserId: null, senderKind: kind, direction: 'OUTBOUND', content },
    include: MESSAGE_INCLUDE
  });
  broadcastMessage(organizationId, conversationId, message);
  return message;
}

module.exports = {
  CONVERSATION_INCLUDE,
  MESSAGE_INCLUDE,
  sanitizeConversation,
  sanitizeMessage,
  broadcastMessage,
  sendBotMessage
};
