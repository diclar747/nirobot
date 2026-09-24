const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { emitToOrg, emitToUser } = require('../lib/realtime');
const { requireAuth, requireCsrf, requireOrgContext } = require('../middleware/auth');
const {
  STATUSES,
  PRIORITIES,
  createConversationSchema,
  updateConversationSchema,
  outcomeRequestSchema: outcomeInputSchema,
  createMessageSchema,
  reactionSchema,
  createPollSchema,
  shareContactSchema
} = require('../validation/conversations.validation');
const { HttpError } = require('../lib/errors');
const { handleBotTurn } = require('../lib/botRunner');
const niroAi = require('../lib/niroAi');
const push = require('../lib/push');
const { KINDS: aiUsageKinds, recordAiUsage } = require('../lib/aiUsage');
const { CONVERSATION_INCLUDE, MESSAGE_INCLUDE, sanitizeConversation, sanitizeMessage, broadcastMessage } = require('../lib/conversations');
const { upload } = require('../middleware/upload');
const { saveFile, resolvePath } = require('../lib/storage');
const { extensionFor, normalizeMimeType, sendAttachmentFile } = require('../lib/attachments');
const fsp = require('fs/promises');
const whatsapp = require('../lib/whatsapp');

const chatAccess = require('../lib/chatAccess');
const outcomes = require('../lib/outcomes');

const router = express.Router();

router.use(requireAuth, requireOrgContext);

async function visibilityWhere(req) {
  if (req.auth.role !== 'AGENT') return {};
  return chatAccess.agentVisibilityWhere(await chatAccess.agentAccess(req.auth.organizationId, req.auth.userId));
}


// ---- No leídos (como WhatsApp Web) ----
// Un mensaje ENTRANTE es "no leído" si llegó después de la última vez que ESTE usuario abrió esa conversación.
// Sin registro previo (usuario nuevo) se cuenta desde que se creó el usuario, para no llenarlo de historial viejo.
async function unreadByConversation(userId, conversationIds) {
  if (conversationIds.length === 0) return new Map();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
  const baseline = user?.createdAt || new Date(0);
  const rows = await prisma.$queryRaw`
    SELECT m."conversationId" AS id, COUNT(*)::int AS n
    FROM "Message" m
    LEFT JOIN "ConversationRead" r ON r."conversationId" = m."conversationId" AND r."userId" = ${userId}
    WHERE m."conversationId" = ANY(${conversationIds}) AND m."direction" = 'INBOUND'
      AND m."createdAt" > COALESCE(r."lastReadAt", ${baseline})
    GROUP BY m."conversationId"`;
  return new Map(rows.map((row) => [row.id, Number(row.n)]));
}

async function lastMessageByConversation(conversationIds) {
  if (conversationIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (m."conversationId") m."conversationId" AS id, m."content", m."direction", m."contentType", m."createdAt"
    FROM "Message" m
    WHERE m."conversationId" = ANY(${conversationIds}) AND m."direction" <> 'NOTE'
    ORDER BY m."conversationId", m."createdAt" DESC`;
  return new Map(rows.map((row) => [row.id, { content: String(row.content || '').slice(0, 120), direction: row.direction, contentType: row.contentType, at: row.createdAt }]));
}

router.get('/unread-summary', async (req, res, next) => {
  try {
    const visible = await prisma.conversation.findMany({ where: { organizationId: req.auth.organizationId, ...(await visibilityWhere(req)), status: { not: 'CLOSED' } }, select: { id: true }, take: 1000 });
    const map = await unreadByConversation(req.auth.userId, visible.map((c) => c.id));
    let messages = 0;
    for (const n of map.values()) messages += n;
    res.json({ conversations: map.size, messages });
  } catch (err) { next(err); }
});

router.post('/:id/read', requireCsrf, async (req, res, next) => {
  try {
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');
    await prisma.conversationRead.upsert({
      where: { conversationId_userId: { conversationId: conversation.id, userId: req.auth.userId } },
      update: { lastReadAt: new Date() },
      create: { conversationId: conversation.id, userId: req.auth.userId }
    });
    emitToUser(req.auth.userId, 'conversation:read', { conversationId: conversation.id }); // otras pestañas/dispositivos del mismo usuario
    res.json({ ok: true });
  } catch (err) { next(err); }
});

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

    const ids = conversations.map((c) => c.id);
    const [unread, last] = await Promise.all([unreadByConversation(req.auth.userId, ids), lastMessageByConversation(ids)]);
    res.json({ conversations: conversations.map((c) => ({ ...sanitizeConversation(c), unreadCount: unread.get(c.id) || 0, lastMessage: last.get(c.id) || null })) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const data = createConversationSchema.parse(req.body);

    let contactId = data.contactId;
    let chosenContact;
    if (contactId) {
      chosenContact = await prisma.contact.findFirst({ where: { id: contactId, organizationId: req.auth.organizationId } });
      if (!chosenContact) throw new HttpError(404, 'Contacto no encontrado');
    } else {
      chosenContact = await prisma.contact.create({ data: { ...data.newContact, organizationId: req.auth.organizationId } });
      contactId = chosenContact.id;
    }

    // Un contacto con teléfono se atiende por WhatsApp: sin canal, el chat quedaba "manual" y lo que se escribía nunca salía.
    const channel = data.channel || (chosenContact.phone ? 'whatsapp' : 'manual');

    // Un solo chat por contacto: se abre el que ya existe (si estaba cerrado, se reabre) en vez de duplicarlo.
    if (channel === 'whatsapp' && data.contactId) {
      let existing = await prisma.conversation.findFirst({
        where: { organizationId: req.auth.organizationId, contactId, channel: 'whatsapp' },
        orderBy: { updatedAt: 'desc' },
        include: CONVERSATION_INCLUDE
      });
      if (existing && existing.status === 'CLOSED') {
        existing = await prisma.conversation.update({ where: { id: existing.id }, data: { status: 'OPEN' }, include: CONVERSATION_INCLUDE });
      }
      if (existing) return res.status(200).json({ conversation: sanitizeConversation(existing), existing: true });
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
        channel,
        // El chat que inicia una persona queda a su nombre (el bot y la IA no se meten).
        ...(channel === 'whatsapp' ? { assignedToId: req.auth.userId } : {})
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
    // La bienvenida automática es para clientes que escriben primero, no para chats iniciados por un agente.
    if (!data.departmentId && channel !== 'whatsapp') {
      const settings = await prisma.organizationSettings.findUnique({ where: { organizationId: req.auth.organizationId }, include: { organization: { select: { name: true } } } });
      const turn = await handleBotTurn({
        organizationId: req.auth.organizationId,
        conversation,
        contact: conversation.contact,
        content: '',
        isNewConversation: true,
        settings,
        organizationName: settings?.organization?.name || null
      });
      if (turn) finalConversation = turn.conversation;
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

// Las notas marcadas como "solo administración" no se listan para los agentes.
const STAFF_ROLES = ['OWNER', 'ADMIN', 'SUPERVISOR'];
function staffOnlyFilter(req) {
  return STAFF_ROLES.includes(req.auth.role) ? {} : { staffOnly: false };
}

router.get('/:id', async (req, res, next) => {
  try {
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id, ...staffOnlyFilter(req) },
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
      where: { conversationId: conversation.id, ...staffOnlyFilter(req), ...(before && !Number.isNaN(new Date(before).getTime()) ? { createdAt: { lt: new Date(before) } } : {}) },
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
    const parsed = updateConversationSchema.parse(req.body);
    const { outcome: outcomeInput, ...data } = parsed;
    const existing = await loadVisibleConversation(req, req.params.id);
    if (!existing) throw new HttpError(404, 'Conversación no encontrada');

    // Cerrar o resolver una conversación exige indicar cómo terminó (venta cerrada, perdida, cotización…).
    const CLOSED_STATUSES = ['RESOLVED', 'CLOSED'];
    const closing = CLOSED_STATUSES.includes(data.status) && !CLOSED_STATUSES.includes(existing.status);
    if (closing && !outcomeInput && await outcomes.hasActiveCategories(req.auth.organizationId)) {
      throw Object.assign(new HttpError(400, 'Elegí cómo terminó la conversación (venta cerrada, venta perdida, cotización…)'), { code: 'OUTCOME_REQUIRED' });
    }
    if (!closing && Object.keys(data).length === 0) throw new HttpError(400, 'No hay cambios para aplicar');

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

    const actor = { id: req.auth.userId, name: (await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { name: true } }))?.name };
    let createdOutcome = null;
    const conversation = await prisma.$transaction(async (tx) => {
      const updated = await tx.conversation.update({ where: { id: existing.id }, data, include: CONVERSATION_INCLUDE });
      if (closing && outcomeInput) {
        // Se registra con el estado pedido (resuelta o cerrada) y la etapa "Cerradas" del CRM.
        const { outcome, conversation: closed } = await outcomes.createOutcome(tx, { organizationId: req.auth.organizationId, conversation: updated, actor, ...outcomeInput, close: true, status: data.status });
        createdOutcome = outcome;
        return { ...updated, ...(closed || {}) };
      }
      return updated;
    });
    if (createdOutcome) await outcomes.postOutcomeNote({ organizationId: req.auth.organizationId, conversationId: conversation.id, outcome: createdOutcome, userId: req.auth.userId }).catch((err) => console.error('[outcome] nota en el chat falló:', err.message || err));

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

// Registrar una gestión sobre la conversación (p. ej. "cotización enviada"), cerrándola o no.
router.post('/:id/outcome', requireCsrf, async (req, res, next) => {
  try {
    const input = outcomeInputSchema.parse(req.body);
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');
    const actor = { id: req.auth.userId, name: (await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { name: true } }))?.name };
    const result = await prisma.$transaction((tx) => outcomes.createOutcome(tx, { organizationId: req.auth.organizationId, conversation, actor, categoryId: input.categoryId, amount: input.amount, note: input.note, close: input.close === true, status: input.status }));
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'conversation.outcome',
      entityType: 'Conversation',
      entityId: conversation.id,
      metadata: { category: result.outcome.categoryName, kind: result.outcome.kind, amount: result.outcome.amount === null ? null : Number(result.outcome.amount), closed: Boolean(input.close) }
    });
    await outcomes.postOutcomeNote({ organizationId: req.auth.organizationId, conversationId: conversation.id, outcome: result.outcome, userId: req.auth.userId }).catch((err) => console.error('[outcome] nota en el chat falló:', err.message || err));
    let payload = null;
    if (result.conversation) {
      const full = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: CONVERSATION_INCLUDE });
      payload = sanitizeConversation(full);
      emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: payload });
    }
    res.status(201).json({ outcome: outcomes.sanitizeOutcome({ ...result.outcome, contact: null, category: null }), conversation: payload });
  } catch (err) { next(err); }
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
      claimWhere.OR = chatAccess.agentClaimWhere(await chatAccess.agentAccess(req.auth.organizationId, req.auth.userId));
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

router.post('/:id/transfer', requirePermission('transferChats'), requireCsrf, async (req, res, next) => {
  try {
    const { targetUserId, departmentId } = req.body;
    const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : undefined;
    // Visibility-scoped: an AGENT can only move conversations they could already see.
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');
    if (req.auth.role === 'AGENT' && conversation.assignedToId && conversation.assignedToId !== req.auth.userId) {
      throw new HttpError(403, 'Solo podés transferir conversaciones asignadas a vos o sin asignar');
    }

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

    const noteMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderUserId: req.auth.userId,
        direction: 'NOTE',
        content: noteContent
      },
      include: MESSAGE_INCLUDE
    });
    broadcastMessage(req.auth.organizationId, conversation.id, noteMessage);

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

router.post('/:id/transfer-response', requirePermission('transferChats'), requireCsrf, async (req, res, next) => {
  try {
    const { action } = req.body; // 'accept' | 'reject'
    const reason = typeof req.body.reason === 'string' ? req.body.reason.slice(0, 500) : undefined;
    if (!['accept', 'reject'].includes(action)) throw new HttpError(400, 'Acción inválida');
    const conversation = await loadVisibleConversation(req, req.params.id);
    if (!conversation) throw new HttpError(404, 'Conversación no encontrada');
    // Only the agent the conversation was transferred to may answer the transfer.
    if (conversation.assignedToId && conversation.assignedToId !== req.auth.userId) {
      throw new HttpError(403, 'Esta transferencia no está dirigida a vos');
    }

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

      const noteMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderUserId: req.auth.userId,
          direction: 'NOTE',
          // Solo la ve la administración: el agente ya sabe que aceptó, y al cliente no le aporta nada.
          staffOnly: true,
          content: `✅ ${agentName} aceptó la transferencia de la conversación.`
        },
        include: MESSAGE_INCLUDE
      });
      broadcastMessage(req.auth.organizationId, conversation.id, noteMessage);

      // Si venía derivado por el bot, el cliente recibe el saludo del agente que aceptó.
      await require('../lib/botHandoff').sendAgentWelcome({ organizationId: req.auth.organizationId, conversationId: conversation.id, agent: { id: req.auth.userId, name: agentName } }).catch((err) => console.error('[bot] saludo falló', err));

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

      const noteMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderUserId: req.auth.userId,
          direction: 'NOTE',
          content: `❌ ${agentName} rechazó la transferencia.${reason ? ` Motivo: ${reason}` : ''} La conversación volvió a la cola de espera.`
        },
        include: MESSAGE_INCLUDE
      });
      broadcastMessage(req.auth.organizationId, conversation.id, noteMessage);

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
        ...(direction === 'OUTBOUND' && conversation.channel === 'whatsapp' && conversation.contact.phone ? { deliveryStatus: 'pending' } : {}),
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
        .then((waMessageId) => prisma.message.update({
          where: { id: message.id },
          data: { deliveryStatus: waMessageId ? 'sent' : 'failed', ...(waMessageId ? { waMessageId } : {}) },
          include: MESSAGE_INCLUDE
        }))
        .then((withId) => {
          emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(withId) });
        })
        .catch(async (err) => {
          console.error('[whatsapp] outbound send failed', err);
          const failed = await prisma.message.update({ where: { id: message.id }, data: { deliveryStatus: 'failed' }, include: MESSAGE_INCLUDE }).catch(() => null);
          if (failed) emitToOrg(req.auth.organizationId, 'message:updated', { conversationId: conversation.id, message: sanitizeMessage(failed) });
        });
    }

    if (direction === 'INBOUND' && !conversation.departmentId) {
      const settings = await prisma.organizationSettings.findUnique({
        where: { organizationId: req.auth.organizationId },
        include: { organization: { select: { name: true } } }
      });
      await handleBotTurn({
        organizationId: req.auth.organizationId,
        conversation: updated,
        contact: updated.contact,
        content: data.content,
        isNewConversation: false,
        settings,
        organizationName: settings?.organization?.name || null,
        deliver: updated.channel === 'whatsapp' && updated.contact?.phone
          ? (text) => whatsapp.sendText(req.auth.organizationId, updated.contact.phone, text)
          : null
      });
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

    const direction = String(req.body.type || 'outbound').toUpperCase();
    if (!['OUTBOUND', 'INBOUND', 'NOTE'].includes(direction)) throw new HttpError(400, 'Tipo de mensaje inválido');
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
