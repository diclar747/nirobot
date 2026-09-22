const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { z } = require('zod');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { contactSchema } = require('../validation/conversations.validation');
const { HttpError } = require('../lib/errors');
const { resolvePath } = require('../lib/storage');
const { contactAvatarUrlFor } = require('../lib/avatars');

const router = express.Router();

const CONSENT_STATUSES = ['UNKNOWN', 'GRANTED', 'DENIED', 'REVOKED'];
const CONSENT_ROLES = ['OWNER', 'ADMIN', 'SUPERVISOR'];
const optionalDate = z.union([z.string().datetime({ offset: true }), z.string().min(8).max(40), z.null()]).optional();
const updateContactSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  phone: z.string().min(3).max(40).nullable().optional(),
  email: z.string().email().max(200).nullable().optional().or(z.literal('')),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
  callConsentStatus: z.enum(CONSENT_STATUSES).optional(),
  callConsentAt: optionalDate,
  callConsentSource: z.string().max(200).nullable().optional(),
  callOptedOutAt: optionalDate,
  callOptOutSource: z.string().max(200).nullable().optional()
}).strict();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext);

router.get('/avatar/:orgId/:file', (req, res, next) => {
  if (req.params.orgId !== req.auth.organizationId) return next(new HttpError(404, 'Imagen no encontrada'));
  let filePath;
  try {
    filePath = resolvePath(`${req.params.orgId}/${req.params.file}`);
  } catch {
    return next(new HttpError(404, 'Imagen no encontrada'));
  }
  res.sendFile(filePath, (err) => { if (err && !res.headersSent) next(new HttpError(404, 'Imagen no encontrada')); });
});

router.get('/', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.trunc(requestedLimit))) : 100;
    const where = {
      organizationId: req.auth.organizationId,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } }
            ]
          }
        : {})
    };
    const contacts = await prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const data = contactSchema.parse(req.body);
    const contact = await prisma.contact.create({ data: { ...data, organizationId: req.auth.organizationId } });
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'contact.created',
      entityType: 'Contact',
      entityId: contact.id
    });
    res.status(201).json({ contact });
  } catch (err) {
    next(err);
  }
});


const CRM_STAGE_TAGS = ['Abiertas', 'Pendientes', 'Clientes', 'Interesados', 'Cerradas'];
const CRM_STAGE_STATUS = { Abiertas: 'OPEN', Pendientes: 'PENDING', Cerradas: 'CLOSED' };

function stageOf(tags) {
  return (tags || []).find((t) => CRM_STAGE_TAGS.includes(t)) || null;
}

function contactWhere(req) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
  const stage = typeof req.query.stage === 'string' ? req.query.stage.trim() : '';
  const and = [];
  if (q) and.push({ OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }, { email: { contains: q, mode: 'insensitive' } }] });
  if (tag) and.push({ tags: { has: tag } });
  if (stage) and.push({ conversations: { some: { tags: { has: stage } } } });
  if (req.query.named === '1') and.push({ name: { not: null } }, { NOT: { name: '' } });
  return { organizationId: req.auth.organizationId, ...(and.length ? { AND: and } : {}) };
}

// Directorio paginado para el dashboard de contactos.
router.get('/directory', requirePermission('contacts'), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 24));
    const where = contactWhere(req);
    const [total, rows, allTags, withName, withPhone] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.contact.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: [{ name: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        include: { conversations: { select: { id: true, tags: true, status: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 } }
      }),
      prisma.contact.findMany({ where: { organizationId: req.auth.organizationId }, select: { tags: true } }),
      prisma.contact.count({ where: { organizationId: req.auth.organizationId, name: { not: null }, NOT: { name: '' } } }),
      prisma.contact.count({ where: { organizationId: req.auth.organizationId, phone: { not: null } } })
    ]);
    const tags = Array.from(new Set(allTags.flatMap((c) => c.tags))).sort((a, b) => a.localeCompare(b));
    const totalAll = await prisma.contact.count({ where: { organizationId: req.auth.organizationId } });
    res.json({
      contacts: rows.map((c) => ({
        id: c.id, name: c.name, phone: c.phone, email: c.email, avatarUrl: contactAvatarUrlFor(c.avatarUrl), tags: c.tags, createdAt: c.createdAt,
        conversationId: c.conversations[0]?.id || null, crmStage: stageOf(c.conversations[0]?.tags)
      })),
      total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), tags, stats: { total: totalAll, withName, withPhone }
    });
  } catch (err) { next(err); }
});

// Descarga de TODOS los contactos (CSV compatible con Excel).
router.get('/export.csv', requirePermission('contactsExport'), async (req, res, next) => {
  try {
    const rows = await prisma.contact.findMany({
      where: { organizationId: req.auth.organizationId },
      orderBy: [{ name: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      include: { conversations: { select: { tags: true }, orderBy: { updatedAt: 'desc' }, take: 1 } }
    });
    const esc = (value) => {
      const text = String(value ?? '');
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text; // evita inyección de fórmulas en Excel
      return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = ['Nombre,Teléfono,Email,Etiquetas,Etapa CRM,Creado'];
    for (const c of rows) {
      lines.push([c.name, c.phone ? `+${c.phone.replace(/^\+/, '')}` : '', c.email, c.tags.join(' | '), stageOf(c.conversations[0]?.tags) || '', c.createdAt.toISOString()].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contactos-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${lines.join('\r\n')}`);
  } catch (err) { next(err); }
});

// Enviar un contacto a una etapa/etiqueta del CRM (crea la conversación si todavía no existe).
router.post('/:id/crm', requirePermission('crm'), requireCsrf, async (req, res, next) => {
  try {
    const stage = String(req.body?.stage || '');
    if (!CRM_STAGE_TAGS.includes(stage)) throw new HttpError(400, 'Etapa de CRM inválida');
    const contact = await prisma.contact.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!contact) throw new HttpError(404, 'Contacto no encontrado');
    let conversation = await prisma.conversation.findFirst({ where: { contactId: contact.id, organizationId: req.auth.organizationId }, orderBy: { updatedAt: 'desc' } });
    const status = CRM_STAGE_STATUS[stage];
    if (!conversation) {
      conversation = await prisma.conversation.create({ data: { organizationId: req.auth.organizationId, contactId: contact.id, channel: 'whatsapp', status: status || 'OPEN', tags: [stage] } });
    } else {
      const tags = [...conversation.tags.filter((t) => !CRM_STAGE_TAGS.includes(t)), stage];
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { tags, ...(status ? { status } : {}) } });
    }
    await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'contact.sent_to_crm', entityType: 'Contact', entityId: contact.id, metadata: { stage } });
    try {
      const full = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: require('../lib/conversations').CONVERSATION_INCLUDE });
      const { sanitizeConversation } = require('../lib/conversations');
      require('../lib/realtime').emitToOrg(req.auth.organizationId, 'conversation:updated', { conversation: sanitizeConversation(full) });
    } catch { /* el tablero se actualiza al recargar */ }
    res.json({ conversationId: conversation.id, crmStage: stage });
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('contactsDelete'), requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!existing) throw new HttpError(404, 'Contacto no encontrado');
    await prisma.contact.delete({ where: { id: existing.id } });
    await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'contact.deleted', entityType: 'Contact', entityId: existing.id, metadata: { name: existing.name, phone: existing.phone } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId },
      include: {
        conversations: { orderBy: { updatedAt: 'desc' }, take: 5 },
        orders: { orderBy: { createdAt: 'desc' }, take: 5 }
      }
    });
    if (!contact) throw new HttpError(404, 'Contacto no encontrado');
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.contact.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!existing) throw new HttpError(404, 'Contacto no encontrado');

    const { name, phone, email, tags, avatarUrl, callConsentStatus, callConsentAt, callConsentSource, callOptedOutAt, callOptOutSource } = updateContactSchema.parse(req.body);
    // Call consent is a legal record: agents may not grant it or clear an opt-out.
    const touchesConsent = [callConsentStatus, callConsentAt, callConsentSource, callOptedOutAt, callOptOutSource].some((value) => typeof value !== 'undefined');
    if (touchesConsent && !CONSENT_ROLES.includes(req.auth.role)) {
      throw new HttpError(403, 'Solo un supervisor o administrador puede modificar el consentimiento de llamadas');
    }
    const data = {};
    if (typeof name !== 'undefined') data.name = name;
    if (typeof phone !== 'undefined') data.phone = phone;
    if (typeof email !== 'undefined') data.email = email || null;
    if (Array.isArray(tags)) data.tags = tags;
    if (typeof avatarUrl !== 'undefined') data.avatarUrl = avatarUrl;
    if (typeof callConsentStatus !== 'undefined') data.callConsentStatus = callConsentStatus;
    if (typeof callConsentAt !== 'undefined') data.callConsentAt = callConsentAt ? new Date(callConsentAt) : null;
    if (typeof callConsentSource !== 'undefined') data.callConsentSource = callConsentSource;
    if (typeof callOptedOutAt !== 'undefined') data.callOptedOutAt = callOptedOutAt ? new Date(callOptedOutAt) : null;
    if (typeof callOptOutSource !== 'undefined') data.callOptOutSource = callOptOutSource;

    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data
    });

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'contact.updated',
      entityType: 'Contact',
      entityId: contact.id,
      metadata: data
    });

    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
