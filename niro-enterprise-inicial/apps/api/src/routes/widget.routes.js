const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { emitToOrg } = require('../lib/realtime');
const { renderWelcome, matchMenuOption } = require('../lib/bot');
const { runBotFlow, conversationUpdateData } = require('../lib/botFlow');
const aiBot = require('../lib/aiBot');
const push = require('../lib/push');
const { CONVERSATION_INCLUDE, MESSAGE_INCLUDE, sanitizeConversation, sanitizeMessage, broadcastMessage, sendBotMessage } = require('../lib/conversations');
const { startSchema, messageSchema, tokenSchema } = require('../validation/widget.validation');
const { HttpError } = require('../lib/errors');
const { upload } = require('../middleware/upload');
const { saveFile } = require('../lib/storage');
const { extensionFor, sendAttachmentFile } = require('../lib/attachments');

const router = express.Router();

const widgetLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
router.use((req, res, next) => {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});
router.use(widgetLimiter);

async function getActiveOrgBySlug(slug) {
  const organization = await prisma.organization.findUnique({ where: { slug }, include: { settings: true } });
  if (!organization || !organization.active) throw new HttpError(404, 'Organización no encontrada');
  return organization;
}

// A widget visitor is never a User: only ever reachable via its own opaque per-conversation
// token, never by id, and always re-scoped to the :slug in the URL so a token from org A can
// never be replayed against org B's endpoint even if somehow guessed.
async function loadWidgetConversation(slug, token) {
  const conversation = await prisma.conversation.findFirst({
    where: { widgetToken: token, organization: { slug, active: true } },
    include: CONVERSATION_INCLUDE
  });
  if (!conversation) throw new HttpError(404, 'Conversación no encontrada');
  return conversation;
}

router.get('/:slug/info', async (req, res, next) => {
  try {
    const organization = await getActiveOrgBySlug(req.params.slug);
    res.json({
      name: organization.name,
      welcomeMessage: organization.settings?.welcomeMessage || '¡Hola! ¿En qué podemos ayudarte?'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:slug/start', async (req, res, next) => {
  try {
    const organization = await getActiveOrgBySlug(req.params.slug);
    const data = startSchema.parse(req.body);

    const contact = await prisma.contact.create({
      data: {
        organizationId: organization.id,
        name: data.name,
        email: data.email,
        phone: data.phone,
        externalId: 'widget'
      }
    });

    const token = crypto.randomBytes(24).toString('base64url');
    let conversation = await prisma.conversation.create({
      data: { organizationId: organization.id, contactId: contact.id, channel: 'web', widgetToken: token },
      include: CONVERSATION_INCLUDE
    });

    await audit(prisma, {
      organizationId: organization.id,
      action: 'conversation.created',
      entityType: 'Conversation',
      entityId: conversation.id,
      metadata: { channel: 'web' }
    });

    const flowResult = runBotFlow(organization.settings?.botFlow, { content: '', contact, conversation, isNewConversation: true });
    if (flowResult) {
      const flowData = conversationUpdateData(conversation, flowResult);
      if (Object.keys(flowData).length > 0) {
        conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: flowData, include: CONVERSATION_INCLUDE });
      }
      for (const reply of flowResult.replies) await sendBotMessage(conversation.id, organization.id, reply);
    } else if (organization.settings?.aiEnabled) {
      await sendBotMessage(conversation.id, organization.id, renderWelcome(organization.settings));
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
        include: CONVERSATION_INCLUDE
      });
    }

    emitToOrg(organization.id, 'conversation:new', { conversation: sanitizeConversation(conversation) });

    res.status(201).json({ token, conversation: sanitizeConversation(conversation) });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/conversation', async (req, res, next) => {
  try {
    const { token } = tokenSchema.parse(req.query);
    const conversation = await loadWidgetConversation(req.params.slug, token);

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id, direction: { not: 'NOTE' } },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json({ conversation: sanitizeConversation(conversation), messages: messages.reverse().map(sanitizeMessage) });
  } catch (err) {
    next(err);
  }
});

router.post('/:slug/messages', async (req, res, next) => {
  try {
    const data = messageSchema.parse(req.body);
    const conversation = await loadWidgetConversation(req.params.slug, data.token);

    if (conversation.status === 'CLOSED') throw new HttpError(409, 'Esta conversación ya fue cerrada');

    const message = await prisma.message.create({
      data: { conversationId: conversation.id, senderUserId: null, direction: 'INBOUND', content: data.content },
      include: MESSAGE_INCLUDE
    });

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date(), status: conversation.status === 'RESOLVED' ? 'OPEN' : conversation.status },
      include: CONVERSATION_INCLUDE
    });

    const payload = broadcastMessage(conversation.organizationId, conversation.id, message);
    emitToOrg(conversation.organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
    push.notifyNewInboundMessage({
      organizationId: conversation.organizationId,
      conversation: updated,
      contactLabel: conversation.contact.name || conversation.contact.phone || conversation.contact.email || 'Visitante',
      preview: data.content,
      channel: 'web'
    });

    if (!conversation.departmentId && !(await require('../lib/billing').isBlocked(conversation.organizationId).catch(() => false))) {
      const settings = await prisma.organizationSettings.findUnique({
        where: { organizationId: conversation.organizationId },
        include: { organization: { select: { name: true } } }
      });
      const flowResult = runBotFlow(settings?.botFlow, { content: data.content, contact: updated.contact, conversation: updated, isNewConversation: false });
      if (flowResult) {
        const flowData = conversationUpdateData(updated, flowResult);
        const routed = Object.keys(flowData).length > 0
          ? await prisma.conversation.update({ where: { id: conversation.id }, data: flowData, include: CONVERSATION_INCLUDE })
          : updated;
        for (const reply of flowResult.replies) await sendBotMessage(conversation.id, conversation.organizationId, reply);
        if (flowResult.useAi && aiBot.shouldReply(routed, settings)) {
          const aiSettings = flowResult.aiPrompt ? { ...settings, systemPrompt: `${settings.systemPrompt || ''} ${flowResult.aiPrompt}`.trim() } : settings;
          const reply = await aiBot.generateReply(conversation.id, aiSettings, settings.organization?.name || null);
          if (reply && reply.content) await sendBotMessage(conversation.id, conversation.organizationId, reply.content, 'ai');
        }
        emitToOrg(conversation.organizationId, 'conversation:updated', { conversation: sanitizeConversation(routed) });
      } else {
        const option = settings?.aiEnabled ? matchMenuOption(settings, data.content) : null;
        if (option) {
        const routed = await prisma.conversation.update({
          where: { id: conversation.id },
          data: { departmentId: option.departmentId },
          include: CONVERSATION_INCLUDE
        });
        await sendBotMessage(conversation.id, conversation.organizationId, `Te derivamos a ${option.label}. En un momento te atienden.`);
        emitToOrg(conversation.organizationId, 'conversation:updated', { conversation: sanitizeConversation(routed) });
        } else if (aiBot.shouldReply(updated, settings)) {
        const reply = await aiBot.generateReply(conversation.id, settings, settings.organization?.name || null);
        if (reply && reply.content) await sendBotMessage(conversation.id, conversation.organizationId, reply.content, 'ai');
        }
      }
    }

    res.status(201).json({ message: payload });
  } catch (err) {
    next(err);
  }
});

router.post('/:slug/attachments', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Falta el archivo');
    const { token } = tokenSchema.parse({ token: req.body.token });
    const conversation = await loadWidgetConversation(req.params.slug, token);
    if (conversation.status === 'CLOSED') throw new HttpError(409, 'Esta conversación ya fue cerrada');

    const storageKey = await saveFile(conversation.organizationId, req.file.buffer, extensionFor(req.file.mimetype));

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderUserId: null,
        direction: 'INBOUND',
        content: (req.body.content || '').slice(0, 4000),
        contentType: 'attachment',
        attachment: {
          create: {
            organizationId: conversation.organizationId,
            fileName: (req.file.originalname || 'archivo').slice(0, 200),
            mimeType: req.file.mimetype,
            size: req.file.size,
            storageKey
          }
        }
      },
      include: MESSAGE_INCLUDE
    });

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date(), status: conversation.status === 'RESOLVED' ? 'OPEN' : conversation.status },
      include: CONVERSATION_INCLUDE
    });

    const payload = broadcastMessage(conversation.organizationId, conversation.id, message);
    emitToOrg(conversation.organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
    push.notifyNewInboundMessage({
      organizationId: conversation.organizationId,
      conversation: updated,
      contactLabel: conversation.contact.name || conversation.contact.phone || conversation.contact.email || 'Visitante',
      preview: '📎 Adjunto',
      channel: 'web'
    });

    res.status(201).json({ message: payload });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/attachments/:attachmentId', async (req, res, next) => {
  try {
    const { token } = tokenSchema.parse(req.query);
    const conversation = await loadWidgetConversation(req.params.slug, token);

    const attachment = await prisma.attachment.findFirst({
      where: {
        id: req.params.attachmentId,
        organizationId: conversation.organizationId,
        message: { conversationId: conversation.id, direction: { not: 'NOTE' } }
      }
    });
    if (!attachment) throw new HttpError(404, 'Adjunto no encontrado');

    sendAttachmentFile(res, attachment);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
