const express = require('express');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { emitToOrg, emitToUser } = require('../lib/realtime');
const { requireAuth, requireCsrf } = require('../middleware/auth');
const {
  STATUSES,
  PRIORITIES,
  createConversationSchema,
  updateConversationSchema,
  createMessageSchema,
  reactionSchema,
  createPollSchema,
  shareContactSchema
} = require('../validation/conversations.validation');
const { HttpError } = require('../lib/errors');
const { renderWelcome, matchMenuOption } = require('../lib/bot');
const { runBotFlow, conversationUpdateData } = require('../lib/botFlow');
const aiBot = require('../lib/aiBot');
const niroAi = require('../lib/niroAi');
const push = require('../lib/push');
const { KINDS: aiUsageKinds, recordAiUsage } = require('../lib/aiUsage');
const { CONVERSATION_INCLUDE, MESSAGE_INCLUDE, sanitizeConversation, sanitizeMessage, broadcastMessage, sendBotMessage } = require('../lib/conversations');
const { upload } = require('../middleware/upload');
const { saveFile, resolvePath } = require('../lib/storage');
const { extensionFor, normalizeMimeType, sendAttachmentFile } = require('../lib/attachments');
const fsp = require('fs/promises');
const whatsapp = require('../lib/whatsapp');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext);

async function agentDepartmentIds(organizationId, userId) {
  const memberships = await prisma.departmentMember.findMany({
    where: { userId, department: { organizationId } },
    select: { departmentId: true }
  });
  return memberships.map((m) => m.departmentId);
}

async function visibilityWhere(req) {
  if (req.auth.role !== 'AGENT') return {};
  const deptIds = await agentDepartmentIds(req.auth.organizationId, req.auth.userId);
  return {
    OR: [
      { assignedToId: req.auth.userId },
      { assignedToId: null, OR: [{ departmentId: null }, { departmentId: { in: deptIds } }] }
    ]
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { status, priority, departmentId, q, tag } = req.query;
    const assignedToId = req.query.assignedToId;

    const where = { organizationId: req.auth.organizationId, ...(await visibilityWhere(req)) };
    const andClauses = [];

    if (status && STATUSES.includes(status)) andClauses.push({ status });
    if (priority && PRIORITIES.includes(priority)) andClauses.push({ priority });
    if (departmentId) andClauses.push({ departmentId: departmentId === 'none' ? null : departmentId });
    if (assignedToId === 'me') andClauses.push({ assignedToId: req.auth.userId });
    else if (assignedToId === 'none') andClauses.push({ assignedToId: null });
    else if (typeof assignedToId === 'string' && assignedToId) andClauses.push({ assignedToId });
    if (typeof tag === 'string' && tag) andClauses.push({ tags: { has: tag } });
    if (typeof q === 'string' && q.trim()) {
      const query = q.trim();
      andClauses.push({
        OR: [
          { contact: { name: { contains: query, mode: 'insensitive' } } },
          { contact: { phone: { contains: query, mode: 'insensitive' } } },
          { contact: { email: { contains: query, mode: 'insensitive' } } },
          { messages: { some: { content: { contains: query, mode: 'insensitive' } } } }
        ]
      });
    }
    if (andClauses.length) where.AND = andClauses;

    const conversations = await prisma.conversation.findMany({
      where,
      include: CONVERSATION_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      take: 100
    });

    res.json({ conversations: conversations.map(sanitizeConversation) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const data = createConversationSchema.parse(req.body);

    let contactId = data.contactId;
    if (contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId: req.auth.organizationId } });
      if (!contact) throw new HttpError(404, 'Contacto no encontrado');
    } else {
      const contact = await prisma.contact.create({ data: { ...data.newContact, organizationId: req.auth.organizationId } });
      contactId = contact.id;
    }

    if (data.departmentId) {
      const dept = await prisma.department.findFirst({ where: { id: data.departmentId, organizationId: req.auth.organizationId } });
      if (!dept) throw new HttpError(404, 'Departamento no encontrado');
    }

    const conversation = await prisma.conversation.create({
      data: {
        organizationId: req.auth.organizationId,
        contactId,
        subject: data.subject,
        departmentId: data.departmentId,
        channel: data.channel || 'manual'
      },
      include: CONVERSATION_INCLUDE
    });

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'conversation.created',
      entityType: 'Conversation',
      entityId: conversation.id
    });

    let finalConversation = conversation;
    if (!data.departmentId) {
      const settings = await prisma.organizationSettings.findUnique({ where: { organizationId: req.auth.organizationId } });
      const flowResult = runBotFlow(settings?.botFlow, { content: '', contact: conversation.contact, conversation, isNewConversation: true });
      if (flowResult) {
        const flowData = conversationUpdateData(conversation, flowResult);
        if (Object.keys(flowData).length > 0) {
          finalConversation = await prisma.conversation.update({ where: { id: conversation.id }, data: flowData, include: CONVERSATION_INCLUDE });
        }
        for (const reply of flowResult.replies) await sendBotMessage(conversation.id, req.auth.organizationId, reply);
      } else if (settings?.aiEnabled) {
        await sendBotMessage(conversation.id, req.auth.organizationId, renderWelcome(settings));
        finalConversation = await prisma.conversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
          include: CONVERSATION_INCLUDE
        });
      }
    }

    const payload = sanitizeConversation(finalConversation);
    emitToOrg(req.auth.organizationId, 'conversation:new', { conversation: payload });
    res.status(201).json({ conversation: payload });
  } catch (err) {
    next(err);
  }
});

async function loadVisibleConversation(req, id) {
  const where = { id, organizationId: req.auth.organizationId, ...(await visibilityWhere(req)) };
  return prisma.conversation.findFirst({ where, include: CONVERSATION_INCLUDE });
}

router.get('/:id', async (req, res, next) => {
  try {
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json({ conversation: sanitizeConversation(conversation), messages: messages.reverse().map(sanitizeMessage) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/messages', async (req, res, next) => {
  try {
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const before = req.query.before;
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json({ messages: messages.reverse().map(sanitizeMessage) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireCsrf, async (req, res, next) => {
  try {
    const data = updateConversationSchema.parse(req.body);
    const existing = await loadVisibleConversation(req, req.params.id);
    if (!existing) throw new HttpError(404, 'Conversación no encontrada');

    if (
      typeof data.assignedToId !== 'undefined' &&
      data.assignedToId &&
      data.assignedToId !== req.auth.userId &&
      req.auth.role === 'AGENT'
    ) {
      throw new HttpError(403, 'Un agente solo puede asignarse conversaciones a sí mismo');
    }

    if (data.departmentId) {
      const dept = await prisma.department.findFirst({ where: { id: data.departmentId, organizationId: req.auth.organizationId } });
      if (!dept) throw new HttpError(404, 'Departamento no encontrado');
    }
    if (data.assignedToId) {
      const user = await prisma.user.findFirst({ where: { id: data.assignedToId, organizationId: req.auth.organizationId, active: true } });
      if (!user) throw new HttpError(404, 'Usuario no encontrado');
    }

    const conversation = await prisma.conversation.update({
      where: { id: existing.id },
      data,
      include: CONVERSATION_INCLUDE
    });

    let action = 'conversation.updated';
    if (typeof data.assignedToId !== 'undefined') action = 'conversation.assigned';
    else if (data.status) action = 'conversation.status_changed';

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action,
      entityType: 'Conversation',
      entityId: conversation.id,
      metadata: data
    });

    const payload = sanitizeConversation(conversation);
    emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: payload });
    res.json({ conversation: payload });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/claim', requireCsrf, async (req, res, next) => {
  try {
    // A org-scoped (not visibility-scoped) existence check: visibility for AGENT depends on
    // assignedToId, which is exactly the field this atomic update races on. Checking visibility
    // up front would make the loser of the race see the conversation as "not found" once the
    // winner's assignment lands, instead of the correct "already taken".
    const existing = await prisma.conversation.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!existing) throw new HttpError(404, 'Conversación no encontrada');

    const claimWhere = { id: existing.id, assignedToId: null };
    if (req.auth.role === 'AGENT') {
      const deptIds = await agentDepartmentIds(req.auth.organizationId, req.auth.userId);
      claimWhere.OR = [{ departmentId: null }, { departmentId: { in: deptIds } }];
    }

    const result = await prisma.conversation.updateMany({ where: claimWhere, data: { assignedToId: req.auth.userId } });
    if (result.count === 0) throw new HttpError(409, 'La conversación ya fue tomada o no está disponible para vos');

    const conversation = await prisma.conversation.findUnique({ where: { id: existing.id }, include: CONVERSATION_INCLUDE });
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'conversation.claimed',
      entityType: 'Conversation',
      entityId: conversation.id
    });

    const payload = sanitizeConversation(conversation);
    emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: payload });
    res.json({ conversation: payload });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/transfer', requireCsrf, async (req, res, next) => {
  try {
    const { targetUserId, departmentId, note } = req.body;
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId },
      include: CONVERSATION_INCLUDE
    });
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    let targetUser = null;
    if (targetUserId) {
      targetUser = await prisma.user.findFirst({
        where: { id: targetUserId, organizationId: req.auth.organizationId, active: true }
      });
      if (!targetUser) throw new HttpError(404, 'Agente destino no encontrado');
    }

    let targetDept = null;
    if (departmentId) {
      targetDept = await prisma.department.findFirst({
        where: { id: departmentId, organizationId: req.auth.organizationId }
      });
      if (!targetDept) throw new HttpError(404, 'Departamento destino no encontrado');
    }

    const sender = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { name: true } });
    const senderName = sender?.name || 'Agente';
    const destinationText = targetUser
      ? `al agente ${targetUser.name}`
      : targetDept
      ? `al departamento ${targetDept.name}`
      : 'a la cola general';

    const noteContent = `🔄 [TRANSFERENCIA]: ${senderName} transfirió la conversación ${destinationText}.${note ? `\nNota: ${note}` : ''}`;

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderUserId: req.auth.userId,
        direction: 'NOTE',
        content: noteContent
      }
    });

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        assignedToId: targetUserId || null,
        departmentId: departmentId || conversation.departmentId,
        status: 'OPEN',
        updatedAt: new Date()
      },
      include: CONVERSATION_INCLUDE
    });

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'conversation.transferred',
      entityType: 'Conversation',
      entityId: conversation.id,
      metadata: { targetUserId, departmentId, note }
    });

    const payload = sanitizeConversation(updated);
    emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: payload });

    if (targetUserId) {
      emitToUser(targetUserId, 'transfer:incoming', {
        conversation: payload,
        fromAgent: senderName,
        note: note || null
      });
      const transferredContactLabel = conversation.contact.name || conversation.contact.phone || 'un cliente';
      push.sendToAgent(req.auth.organizationId, targetUserId, {
        title: `🔄 ${senderName} te transfirió un chat`,
        body: `${transferredContactLabel}${note ? ` — ${note}` : ''}`,
        url: `/inbox?conversation=${conversation.id}`,
        tag: `conversation-${conversation.id}`
      });
    }

    res.json({ conversation: payload, message: 'Transferencia realizada con éxito' });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/transfer-response', requireCsrf, async (req, res, next) => {
  try {
    const { action, reason } = req.body; // 'accept' | 'reject'
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId },
      include: CONVERSATION_INCLUDE
    });
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const agent = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { name: true } });
    const agentName = agent?.name || 'Agente';

    if (action === 'accept') {
      const updated = await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          assignedToId: req.auth.userId,
          status: 'OPEN',
          updatedAt: new Date()
        },
        include: CONVERSATION_INCLUDE
      });

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderUserId: req.auth.userId,
          direction: 'NOTE',
          content: `✅ ${agentName} aceptó la transferencia de la conversación.`
        }
      });

      const payload = sanitizeConversation(updated);
      emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: payload });
      return res.json({ conversation: payload, accepted: true });
    } else {
      const updated = await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          assignedToId: null,
          status: 'PENDING',
          updatedAt: new Date()
        },
        include: CONVERSATION_INCLUDE
      });

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderUserId: req.auth.userId,
          direction: 'NOTE',
          content: `❌ ${agentName} rechazó la transferencia.${reason ? ` Motivo: ${reason}` : ''} La conversación volvió a la cola de espera.`
        }
      });

      const payload = sanitizeConversation(updated);
      emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: payload });
      return res.json({ conversation: payload, accepted: false });
    }
  } catch (err) {
    next(err);
  }
});

function labelForMessage(msg) {
  if (msg.direction === 'NOTE') return 'Nota interna';
  if (msg.direction === 'INBOUND') return 'Cliente';
  return (msg.sender && msg.sender.name) || 'Agente';
}

router.post('/:id/messages', requireCsrf, async (req, res, next) => {
  try {
    const data = createMessageSchema.parse(req.body);
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const direction = (data.type || 'outbound').toUpperCase();

    let quotedMessage = null;
    if (data.quotedMessageId) {
      quotedMessage = await prisma.message.findFirst({
        where: { id: data.quotedMessageId, conversationId: conversation.id },
        include: MESSAGE_INCLUDE
      });
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderUserId: req.auth.userId,
        direction,
        content: data.content,
        quotedMessageId: quotedMessage ? quotedMessage.id : null,
        quotedPreview: quotedMessage ? quotedMessage.content.slice(0, 200) : null,
        quotedSender: quotedMessage ? labelForMessage(quotedMessage) : null
      },
      include: MESSAGE_INCLUDE
    });

    let updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
      include: CONVERSATION_INCLUDE
    });

    const payload = broadcastMessage(req.auth.organizationId, conversation.id, message);
    emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });

    if (direction === 'OUTBOUND' && conversation.channel === 'whatsapp' && conversation.contact.phone) {
      const quotedOption = quotedMessage && quotedMessage.waMessageId
        ? { waMessageId: quotedMessage.waMessageId, fromMe: quotedMessage.direction === 'OUTBOUND', preview: quotedMessage.content.slice(0, 200) }
        : null;
      whatsapp
        .sendText(req.auth.organizationId, conversation.contact.phone, data.content, { quoted: quotedOption })
        .then((waMessageId) => {
          if (!waMessageId) return null;
          return prisma.message.update({ where: { id: message.id }, data: { waMessageId }, include: MESSAGE_INCLUDE });
        })
        .then((withId) => {
          if (withId) emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(withId) });
        })
        .catch((err) => console.error('[whatsapp] outbound send failed', err));
    }

    if (direction === 'INBOUND' && !conversation.departmentId) {
      const settings = await prisma.organizationSettings.findUnique({
        where: { organizationId: req.auth.organizationId },
        include: { organization: { select: { name: true } } }
      });
      const flowResult = runBotFlow(settings?.botFlow, { content: data.content, contact: updated.contact, conversation: updated, isNewConversation: false });
      if (flowResult) {
        const flowData = conversationUpdateData(updated, flowResult);
        if (Object.keys(flowData).length > 0) {
          updated = await prisma.conversation.update({ where: { id: conversation.id }, data: flowData, include: CONVERSATION_INCLUDE });
        }
        for (const reply of flowResult.replies) {
          const botMessage = await sendBotMessage(conversation.id, req.auth.organizationId, reply);
          if (updated.channel === 'whatsapp' && updated.contact?.phone) {
            whatsapp.sendText(req.auth.organizationId, updated.contact.phone, reply).catch((err) => console.error('[whatsapp] flow reply failed', err));
          }
          if (botMessage) emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(botMessage) });
        }
        if (flowResult.useAi && aiBot.shouldReply(updated, settings)) {
          const aiSettings = flowResult.aiPrompt ? { ...settings, systemPrompt: `${settings.systemPrompt || ''} ${flowResult.aiPrompt}`.trim() } : settings;
          const reply = await aiBot.generateReply(conversation.id, aiSettings, settings.organization?.name || null);
          if (reply && reply.content) {
            const botMessage = await sendBotMessage(conversation.id, req.auth.organizationId, reply.content);
            if (updated.channel === 'whatsapp' && updated.contact?.phone) whatsapp.sendText(req.auth.organizationId, updated.contact.phone, reply.content).catch((err) => console.error('[whatsapp] flow ai reply failed', err));
            if (botMessage) emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(botMessage) });
          }
        }
        emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
      } else {
        const option = settings?.aiEnabled ? matchMenuOption(settings, data.content) : null;
        if (option) {
        updated = await prisma.conversation.update({
          where: { id: conversation.id },
          data: { departmentId: option.departmentId },
          include: CONVERSATION_INCLUDE
        });
        await sendBotMessage(
          conversation.id,
          req.auth.organizationId,
          `Te derivamos a ${option.label}. En un momento te atienden.`
        );
        emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
        } else if (aiBot.shouldReply(updated, settings)) {
        const reply = await aiBot.generateReply(conversation.id, settings, settings.organization?.name || null);
        if (reply && reply.content) {
          const botMessage = await sendBotMessage(conversation.id, req.auth.organizationId, reply.content);
          if (updated.channel === 'whatsapp' && updated.contact?.phone) {
            whatsapp
              .sendText(req.auth.organizationId, updated.contact.phone, reply.content)
              .then((waMessageId) => {
                if (!waMessageId) return null;
                return prisma.message.update({ where: { id: botMessage.id }, data: { waMessageId }, include: MESSAGE_INCLUDE });
              })
              .then((withId) => {
                if (withId) emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(withId) });
              })
              .catch((err) => console.error('[whatsapp] ai reply send failed', err));
          }
        }
        }
      }
    }

    res.status(201).json({ message: payload });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attachments', requireCsrf, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Falta el archivo');
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const direction = (req.body.type || 'outbound').toUpperCase();
    const mimeType = normalizeMimeType(req.file.mimetype);
    const storageKey = await saveFile(req.auth.organizationId, req.file.buffer, extensionFor(mimeType));

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderUserId: req.auth.userId,
        direction,
        content: (req.body.content || '').slice(0, 8000),
        contentType: mimeType.startsWith('audio/') && req.body.ptt === 'true' ? 'voice' : 'attachment',
        deliveryStatus: direction === 'OUTBOUND' && conversation.channel === 'whatsapp' ? 'pending' : 'sent',
        attachment: {
          create: {
            organizationId: req.auth.organizationId,
            fileName: (req.file.originalname || 'archivo').slice(0, 200),
            mimeType,
            size: req.file.size,
            storageKey
          }
        }
      },
      include: MESSAGE_INCLUDE
    });

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
      include: CONVERSATION_INCLUDE
    });

    const payload = broadcastMessage(req.auth.organizationId, conversation.id, message);
    emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });

    if (direction === 'OUTBOUND' && conversation.channel === 'whatsapp' && conversation.contact.phone) {
      whatsapp
        .sendMedia(req.auth.organizationId, conversation.contact.phone, {
          buffer: req.file.buffer,
          mimetype: mimeType,
          fileName: (req.file.originalname || 'archivo').slice(0, 200),
          caption: req.body.content ? String(req.body.content).slice(0, 8000) : undefined,
          ptt: req.body.ptt === 'true'
        })
        .then((waMessageId) => {
          return prisma.message.update({ where: { id: message.id }, data: { waMessageId, deliveryStatus: waMessageId ? 'sent' : 'failed' }, include: MESSAGE_INCLUDE });
        })
        .then((withId) => {
          emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(withId) });
        })
        .catch(async (err) => {
          console.error('[whatsapp] outbound media send failed', err);
          const failed = await prisma.message.update({ where: { id: message.id }, data: { deliveryStatus: 'failed' }, include: MESSAGE_INCLUDE }).catch(() => null);
          if (failed) emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(failed) });
        });
    }

    res.status(201).json({ message: payload });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/attachments/:attachmentId', async (req, res, next) => {
  try {
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const attachment = await prisma.attachment.findFirst({
      where: { id: req.params.attachmentId, organizationId: req.auth.organizationId, message: { conversationId: conversation.id } }
    });
    if (!attachment) throw new HttpError(404, 'Adjunto no encontrado');

    sendAttachmentFile(res, attachment);
  } catch (err) {
    next(err);
  }
});

// Procesa con IA (bajo demanda, no automático) un adjunto que ya está en el chat: transcribe un
// audio o hace OCR/lectura de factura sobre una imagen. Se guarda en Message.transcription y se
// devuelve al instante — no espera a que llegue un mensaje nuevo para reintentar.
router.post('/:id/messages/:messageId/ai-read', requireCsrf, async (req, res, next) => {
  try {
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id },
      include: MESSAGE_INCLUDE
    });
    if (!message) throw new HttpError(404, 'Mensaje no encontrado');
    if (!message.attachment) throw new HttpError(400, 'Este mensaje no tiene un adjunto para procesar');
    if (!niroAi.isConfigured()) throw new HttpError(503, 'Falta configurar la API de Niro IA en el servidor');

    const isAudio = /^audio\//.test(message.attachment.mimeType);
    const isImage = /^image\//.test(message.attachment.mimeType);
    if (!isAudio && !isImage) throw new HttpError(400, 'Solo se pueden leer con IA audios e imágenes');

    const buffer = await fsp.readFile(resolvePath(message.attachment.storageKey));
    const mode = req.body && req.body.mode === 'invoice' ? 'invoice' : 'text';

    const result = isAudio
      ? await niroAi.transcribeAudio(buffer, message.attachment.fileName, message.attachment.mimeType)
      : await niroAi.visionExtract(buffer, message.attachment.fileName, message.attachment.mimeType, { mode });
    await recordAiUsage(req.auth.organizationId, isAudio ? aiUsageKinds.TRANSCRIPTION : aiUsageKinds.VISION, result.cost);

    const text = (result && result.text) || '';
    if (!text) throw new HttpError(502, 'Niro IA no devolvió texto para este archivo');

    const updated = await prisma.message.update({
      where: { id: message.id },
      data: { transcription: text },
      include: MESSAGE_INCLUDE
    });

    emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(updated) });
    res.json({ message: sanitizeMessage(updated), data: result.data || null });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/messages/:messageId/react', requireCsrf, async (req, res, next) => {
  try {
    const data = reactionSchema.parse(req.body);
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const target = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: conversation.id } });
    if (!target) throw new HttpError(404, 'Mensaje no encontrado');

    const current = Array.isArray(target.reactions) ? target.reactions : [];
    const withoutMine = current.filter((r) => r.from !== 'agent');
    const nextReactions = data.emoji ? [...withoutMine, { emoji: data.emoji, from: 'agent', at: new Date().toISOString() }] : withoutMine;

    const updatedMessage = await prisma.message.update({
      where: { id: target.id },
      data: { reactions: nextReactions },
      include: MESSAGE_INCLUDE
    });

    const payload = sanitizeMessage(updatedMessage);
    emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: payload });

    if (conversation.channel === 'whatsapp' && conversation.contact.phone && target.waMessageId) {
      whatsapp
        .sendReaction(req.auth.organizationId, conversation.contact.phone, target.waMessageId, target.direction === 'OUTBOUND', data.emoji)
        .catch((err) => console.error('[whatsapp] outbound reaction failed', err));
    }

    res.json({ message: payload });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/messages/:messageId', requireCsrf, async (req, res, next) => {
  try {
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const target = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: conversation.id } });
    if (!target) throw new HttpError(404, 'Mensaje no encontrado');
    if (target.direction === 'INBOUND') throw new HttpError(403, 'No se puede eliminar un mensaje recibido del cliente');

    if (conversation.channel === 'whatsapp' && conversation.contact.phone && target.waMessageId) {
      whatsapp
        .deleteMessage(req.auth.organizationId, conversation.contact.phone, target.waMessageId, target.direction === 'OUTBOUND')
        .catch((err) => console.error('[whatsapp] outbound delete failed', err));
    }

    await prisma.message.delete({ where: { id: target.id } });
    emitToOrg(req.auth.organizationId, 'message:deleted', { conversationId: conversation.id, messageId: target.id });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/messages/poll', requireCsrf, async (req, res, next) => {
  try {
    const data = createPollSchema.parse(req.body);
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderUserId: req.auth.userId,
        direction: 'OUTBOUND',
        content: JSON.stringify({ question: data.question, options: data.options }),
        contentType: 'poll'
      },
      include: MESSAGE_INCLUDE
    });

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
      include: CONVERSATION_INCLUDE
    });

    const payload = broadcastMessage(req.auth.organizationId, conversation.id, message);
    emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });

    if (conversation.channel === 'whatsapp' && conversation.contact.phone) {
      whatsapp
        .sendPoll(req.auth.organizationId, conversation.contact.phone, data.question, data.options)
        .then((waMessageId) => {
          if (!waMessageId) return null;
          return prisma.message.update({ where: { id: message.id }, data: { waMessageId }, include: MESSAGE_INCLUDE });
        })
        .then((withId) => {
          if (withId) emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(withId) });
        })
        .catch((err) => console.error('[whatsapp] outbound poll failed', err));
    }

    res.status(201).json({ message: payload });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/messages/contact', requireCsrf, async (req, res, next) => {
  try {
    const data = shareContactSchema.parse(req.body);
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const sharedContact = await prisma.contact.findFirst({
      where: { id: data.contactId, organizationId: req.auth.organizationId }
    });
    if (!sharedContact) throw new HttpError(404, 'Contacto no encontrado');

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderUserId: req.auth.userId,
        direction: 'OUTBOUND',
        content: JSON.stringify({
          name: sharedContact.name || 'Contacto',
          phone: sharedContact.phone
        }),
        contentType: 'contact'
      },
      include: MESSAGE_INCLUDE
    });

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
      include: CONVERSATION_INCLUDE
    });

    const payload = broadcastMessage(req.auth.organizationId, conversation.id, message);
    emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });

    if (conversation.channel === 'whatsapp' && conversation.contact.phone && sharedContact.phone) {
      whatsapp
        .sendContactCard(req.auth.organizationId, conversation.contact.phone, sharedContact.name || 'Contacto', sharedContact.phone)
        .then((waMessageId) => {
          if (!waMessageId) return null;
          return prisma.message.update({ where: { id: message.id }, data: { waMessageId }, include: MESSAGE_INCLUDE });
        })
        .then((withId) => {
          if (withId) emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(withId) });
        })
        .catch((err) => console.error('[whatsapp] outbound contact share failed', err));
    }

    res.status(201).json({ message: payload });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
