// Historial: registro centralizado y buscable de todos los mensajes de WhatsApp de la empresa
// (no solo por conversación, como el Inbox). Reusa las mismas reglas de visibilidad del Inbox:
// un agente solo ve lo suyo/su área; supervisor y administrador ven toda la empresa.
const express = require('express');
const { prisma } = require('../lib/prisma');
const { requirePermission } = require('../lib/permissions');
const { requireAuth } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { sanitizeAttachment } = require('../lib/attachments');
const chatAccess = require('../lib/chatAccess');
const whatsapp = require('../lib/whatsapp');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext, requirePermission('history'));

async function conversationScopeWhere(req) {
  if (req.auth.role !== 'AGENT') return {};
  return chatAccess.agentVisibilityWhere(await chatAccess.agentAccess(req.auth.organizationId, req.auth.userId));
}

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
const TYPE_LABEL = {
  text: 'Texto', image: 'Imagen', audio: 'Audio', video: 'Video', document: 'Documento',
  sticker: 'Sticker', poll: 'Encuesta', contact: 'Contacto', attachment: 'Adjunto'
};

// Un `type` de la UI puede venir con su variante "-failed" (la descarga de WhatsApp falló pero
// el mensaje igual se registró) — se buscan juntas.
function contentTypeFilter(type) {
  if (!type) return {};
  return { contentType: { in: MEDIA_TYPES.includes(type) ? [type, `${type}-failed`] : [type] } };
}

// El origen no es un campo propio: se deduce de la combinación de campos que ya se guardan.
function originFilter(origin) {
  switch (origin) {
    case 'campaign': return { campaignId: { not: null } };
    case 'api': return { apiKeyId: { not: null } };
    case 'contact': return { direction: 'INBOUND' };
    case 'bot': return { senderKind: 'bot' };
    case 'ai': return { senderKind: 'ai' };
    case 'phone': return { senderKind: 'phone' };
    case 'agent': return { senderUserId: { not: null }, campaignId: null, apiKeyId: null };
    default: return {};
  }
}

function originOf(m) {
  if (m.campaignId) return 'campaign';
  if (m.apiKeyId) return 'api';
  if (m.direction === 'INBOUND') return 'contact';
  if (m.senderKind === 'bot') return 'bot';
  if (m.senderKind === 'ai') return 'ai';
  if (m.senderKind === 'phone') return 'phone';
  if (m.senderUserId) return 'agent';
  return 'system';
}

function dateRange(req) {
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999`) : new Date();
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { gte: from, lte: to };
}

async function buildWhere(req) {
  const { organizationId } = req.auth;
  const { q, direction, status, type, origin, agentId, departmentId } = req.query;
  return {
    conversation: {
      organizationId,
      ...(await conversationScopeWhere(req)),
      ...(departmentId ? { departmentId: String(departmentId) } : {})
    },
    direction: direction && ['INBOUND', 'OUTBOUND'].includes(String(direction)) ? String(direction) : { in: ['INBOUND', 'OUTBOUND'] },
    createdAt: dateRange(req),
    ...(status ? { deliveryStatus: String(status) } : {}),
    ...contentTypeFilter(type ? String(type) : null),
    ...originFilter(origin ? String(origin) : null),
    // Un agentId puntual siempre gana sobre el "senderUserId: not null" genérico de origin=agent.
    ...(agentId ? { senderUserId: String(agentId) } : {}),
    ...(q
      ? {
          OR: [
            { content: { contains: String(q), mode: 'insensitive' } },
            { conversation: { contact: { name: { contains: String(q), mode: 'insensitive' } } } },
            { conversation: { contact: { phone: { contains: String(q).replace(/\D/g, '') || '__none__' } } } }
          ]
        }
      : {})
  };
}

const ROW_INCLUDE = {
  conversation: { select: { id: true, departmentId: true, department: { select: { name: true } }, contact: { select: { id: true, name: true, phone: true, avatarUrl: true } } } },
  sender: { select: { id: true, name: true } },
  campaign: { select: { id: true, name: true } },
  attachment: true
};

function sanitizeRow(m) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    contact: m.conversation.contact ? { id: m.conversation.contact.id, name: m.conversation.contact.name, phone: m.conversation.contact.phone, avatarUrl: m.conversation.contact.avatarUrl } : null,
    department: m.conversation.department ? { id: m.conversation.departmentId, name: m.conversation.department.name } : null,
    direction: m.direction,
    contentType: m.contentType,
    typeLabel: TYPE_LABEL[m.contentType] || TYPE_LABEL[m.contentType.replace(/-failed$/, '')] || m.contentType,
    origin: originOf(m),
    content: m.content,
    preview: String(m.content || '').slice(0, 140),
    agent: m.sender ? { id: m.sender.id, name: m.sender.name } : null,
    campaign: m.campaign ? { id: m.campaign.id, name: m.campaign.name } : null,
    status: m.deliveryStatus,
    attachment: sanitizeAttachment(m.attachment),
    createdAt: m.createdAt
  };
}

router.get('/messages', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));
    const where = await buildWhere(req);

    const [rows, total] = await Promise.all([
      prisma.message.findMany({ where, include: ROW_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.message.count({ where })
    ]);

    const account = whatsapp.getStatus(req.auth.organizationId);
    res.json({ messages: rows.map(sanitizeRow), total, page, pageSize, account: { phone: account.phone || null, name: account.profileName || null } });
  } catch (err) {
    next(err);
  }
});

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) && !/^\+\d+$/.test(text) ? `'${text}` : text;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const ORIGIN_LABEL = { campaign: 'Campaña', api: 'API', contact: 'Contacto', bot: 'Chatbot', ai: 'Bot con IA', phone: 'Teléfono', agent: 'Agente', system: 'Sistema' };
const STATUS_LABEL = { pending: 'Pendiente', sent: 'Enviado', delivered: 'Entregado', read: 'Visto', failed: 'Fallido' };

// Respeta exactamente los mismos filtros que la tabla — nunca más de 20.000 filas por descarga
// para no tumbar el servidor con una consulta sin límite. Va ANTES de /messages/:id: si no,
// Express toma "export.csv" como si fuera el :id.
router.get('/messages/export.csv', async (req, res, next) => {
  try {
    const where = await buildWhere(req);
    const rows = await prisma.message.findMany({ where, include: ROW_INCLUDE, orderBy: { createdAt: 'desc' }, take: 20000 });

    const lines = ['Fecha,Contacto,Teléfono,Dirección,Tipo,Origen,Agente,Campaña,Estado,Mensaje'];
    for (const m of rows) {
      const s = sanitizeRow(m);
      lines.push([
        s.createdAt.toISOString(),
        s.contact?.name || '',
        s.contact?.phone || '',
        s.direction === 'OUTBOUND' ? 'Enviado' : 'Recibido',
        s.typeLabel,
        ORIGIN_LABEL[s.origin] || s.origin,
        s.agent?.name || '',
        s.campaign?.name || '',
        STATUS_LABEL[s.status] || s.status,
        s.preview
      ].map(csvCell).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="historial-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${lines.join('\r\n')}`);
  } catch (err) {
    next(err);
  }
});

router.get('/messages/:id', async (req, res, next) => {
  try {
    const scope = await conversationScopeWhere(req);
    const message = await prisma.message.findFirst({
      where: { id: req.params.id, conversation: { organizationId: req.auth.organizationId, ...scope } },
      include: { ...ROW_INCLUDE, conversation: { select: { id: true, departmentId: true, department: { select: { name: true } }, contact: { select: { id: true, name: true, phone: true, avatarUrl: true } } } } }
    });
    if (!message) throw new HttpError(404, 'Mensaje no encontrado');
    res.json({
      message: {
        ...sanitizeRow(message),
        quotedPreview: message.quotedPreview || null,
        quotedSender: message.quotedSender || null,
        transcription: message.transcription || null,
        reactions: Array.isArray(message.reactions) ? message.reactions : [],
        imported: message.imported
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const { organizationId } = req.auth;
    const scope = await conversationScopeWhere(req);
    const range = dateRange(req);
    const base = { conversation: { organizationId, ...scope }, direction: { in: ['INBOUND', 'OUTBOUND'] }, createdAt: range };
    const count = (extra) => prisma.message.count({ where: { ...base, ...extra } });

    const [
      total, outbound, inbound,
      pending, sent, delivered, read, failed,
      fromAgents, fromCampaigns, fromBots,
      image, audio, video, document, sticker,
      statusPosts
    ] = await Promise.all([
      count({}),
      count({ direction: 'OUTBOUND' }),
      count({ direction: 'INBOUND' }),
      count({ deliveryStatus: 'pending' }),
      count({ deliveryStatus: 'sent' }),
      count({ deliveryStatus: 'delivered' }),
      count({ deliveryStatus: 'read' }),
      count({ deliveryStatus: 'failed' }),
      count({ senderUserId: { not: null } }),
      count({ campaignId: { not: null } }),
      count({ senderKind: { in: ['bot', 'ai'] } }),
      count(contentTypeFilter('image')),
      count(contentTypeFilter('audio')),
      count(contentTypeFilter('video')),
      count(contentTypeFilter('document')),
      count(contentTypeFilter('sticker')),
      prisma.whatsappStatusPost.count({ where: { organizationId, status: 'published', publishedAt: range } }).catch(() => 0)
    ]);

    res.json({
      range: { from: range.gte.toISOString(), to: range.lte.toISOString() },
      total, outbound, inbound,
      byStatus: { pending, sent, delivered, read, failed },
      fromAgents, fromCampaigns, fromBots, statusPosts,
      byType: { image, audio, video, document, sticker }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
