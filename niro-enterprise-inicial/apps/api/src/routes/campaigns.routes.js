const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { createCampaignSchema } = require('../validation/campaigns.validation');
const { upload } = require('../middleware/upload');
const { saveFile, deleteFile } = require('../lib/storage');
const { extensionFor } = require('../lib/attachments');
const { contactAvatarUrlFor } = require('../lib/avatars');
const campaigns = require('../lib/campaigns');
const whatsapp = require('../lib/whatsapp');
const { findUnknownVariables, realName, PUBLIC_VARIABLES } = require('../lib/campaignVariables');
const smsText = require('../lib/smsText');

const router = express.Router();

router.use(requireAuth, requireOrgContext);
router.use(requirePermission('campaigns'));

const CAMPAIGN_INCLUDE = { attachment: true, createdBy: { select: { id: true, name: true } } };

router.get('/', async (req, res, next) => {
  try {
    const list = await prisma.campaign.findMany({
      where: { organizationId: req.auth.organizationId },
      include: CAMPAIGN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 300
    });
    const withCounts = await Promise.all(
      list.map(async (c) => campaigns.sanitizeCampaign(c, await campaigns.getCounts(c.id)))
    );
    res.json({ campaigns: withCounts });
  } catch (err) {
    next(err);
  }
});

router.get('/groups', async (req, res, next) => {
  try {
    const groups = await whatsapp.listGroups(req.auth.organizationId, { force: req.query.refresh === '1' });
    res.json({ groups });
  } catch (err) {
    next(err.status ? new HttpError(err.status, err.message) : err);
  }
});

// Contactos + etiquetas (del contacto y del CRM/conversaciones) para armar la audiencia.
router.get('/audience', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const contacts = await prisma.contact.findMany({
      where: { organizationId, phone: { not: null } },
      select: {
        id: true, name: true, phone: true, email: true, tags: true, createdAt: true,
        conversations: { select: { tags: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 5000
    });
    const rows = contacts.map(({ conversations, ...contact }) => ({
      ...contact,
      crmTags: Array.from(new Set(conversations.flatMap((c) => c.tags)))
    }));
    res.json({ contacts: rows });
  } catch (err) {
    next(err);
  }
});

// Lee una lista pegada: una persona por línea, "número, nombre", "nombre, número" o solo el número.
// Acepta 0985…, 985…, 595985… y números internacionales completos; marca inválidos y repetidos.
router.post('/parse-list', requireCsrf, (req, res, next) => {
  try {
    const rows = smsText.parseRecipientList(String(req.body?.text || '').slice(0, 1_500_000), { max: 10000, allowInternational: true });
    const valid = rows.filter((r) => r.valid);
    res.json({
      rows: rows.slice(0, 500),
      truncated: rows.length > 500,
      summary: { total: rows.length, valid: valid.length, invalid: rows.filter((r) => !r.valid && r.reason !== 'Número repetido').length, duplicates: rows.filter((r) => r.reason === 'Número repetido').length },
      recipients: valid.map((r) => ({ name: r.name, phone: r.phone }))
    });
  } catch (err) {
    next(err);
  }
});

const CAMPAIGN_MANAGERS = requireRole('OWNER', 'ADMIN', 'SUPERVISOR');

// Números pegados en la campaña → contactos del CRM. Los que no existen se crean con su nombre; a los que ya existen
// sin nombre real se les completa. Devuelve { contactId, displayName } en el orden de la lista, sin repetidos.
async function resolveManualRecipients(organizationId, list) {
  const byPhone = new Map();
  for (const item of list) {
    const phone = smsText.normalizePyPhone(item.phone) || smsText.internationalPhone(item.phone);
    if (!phone) continue;
    const name = realName(item.name) ? item.name.trim().slice(0, 120) : null;
    if (!byPhone.has(phone) || (!byPhone.get(phone) && name)) byPhone.set(phone, name);
  }
  if (byPhone.size === 0) return [];
  const phones = [...byPhone.keys()];
  const findExisting = () => prisma.contact.findMany({ where: { organizationId, phone: { in: phones } }, select: { id: true, phone: true, name: true }, orderBy: { createdAt: 'asc' } });
  let existing = await findExisting();
  const known = new Set(existing.map((c) => c.phone));
  const missing = phones.filter((phone) => !known.has(phone));
  if (missing.length > 0) {
    await prisma.contact.createMany({ data: missing.map((phone) => ({ organizationId, phone, name: byPhone.get(phone) || null })) });
    existing = await findExisting();
  }
  const contactByPhone = new Map();
  for (const contact of existing) if (!contactByPhone.has(contact.phone)) contactByPhone.set(contact.phone, contact);
  const toName = [...contactByPhone.values()].filter((c) => !realName(c.name) && byPhone.get(c.phone));
  for (let i = 0; i < toName.length; i += 50) {
    await prisma.$transaction(toName.slice(i, i + 50).map((c) => prisma.contact.update({ where: { id: c.id }, data: { name: byPhone.get(c.phone) } })));
  }
  return phones.map((phone) => ({ contactId: contactByPhone.get(phone).id, displayName: byPhone.get(phone) || null }));
}

// Valida el cuerpo (mensaje, fecha, grupos, audiencia) y devuelve los campos comunes de crear/editar una campaña.
async function campaignInput(req, data) {
  const unknownVariables = findUnknownVariables(data.message);
  if (unknownVariables.length > 0) {
    throw new HttpError(400, `Variable no reconocida: ${unknownVariables.join(', ')}. Usá ${PUBLIC_VARIABLES.join(', ')}`);
  }
  const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'La fecha de programación debe estar en el futuro');
  }

  // Grupos de WhatsApp elegidos: se validan contra los grupos reales de la cuenta conectada.
  let groupTargets = [];
  if (data.groupJids.length > 0) {
    const groups = await whatsapp.listGroups(req.auth.organizationId).catch((err) => { throw new HttpError(err.status || 409, err.message); });
    const byId = new Map(groups.map((group) => [group.id, group]));
    const unknown = data.groupJids.filter((jid) => !byId.has(jid));
    if (unknown.length > 0) throw new HttpError(400, 'Alguno de los grupos elegidos ya no está disponible. Actualizá la lista de grupos');
    groupTargets = data.groupJids.map((jid) => ({ groupJid: jid, groupName: byId.get(jid).name }));
  }

  const recipients = data.contactIds.length === 0 && data.tagFilter.length === 0 ? [] : await prisma.contact.findMany({
    where: {
      organizationId: req.auth.organizationId,
      phone: { not: null },
      OR: [
        ...(data.contactIds.length > 0 ? [{ id: { in: data.contactIds } }] : []),
        ...(data.tagFilter.length > 0
          ? [{ tags: { hasSome: data.tagFilter } }, { conversations: { some: { tags: { hasSome: data.tagFilter } } } }]
          : [])
      ]
    },
    select: { id: true }
  });
  if (recipients.length === 0 && groupTargets.length === 0 && data.manualRecipients.length === 0) {
    throw new HttpError(400, 'Ningún contacto seleccionado tiene un teléfono registrado');
  }
  const manual = await resolveManualRecipients(req.auth.organizationId, data.manualRecipients);
  // Contactos sin repetir: los de la lista pegada conservan su nombre para personalizar el mensaje.
  const contactTargets = new Map(recipients.map((c) => [c.id, null]));
  for (const item of manual) if (!contactTargets.has(item.contactId) || item.displayName) contactTargets.set(item.contactId, item.displayName);
  if (contactTargets.size === 0 && groupTargets.length === 0) {
    throw new HttpError(400, 'Ninguno de los números pegados es válido. Usá un número por línea, por ejemplo 0985768793, Juan');
  }

  const profileRates = { CONSERVATIVE: 10, BALANCED: 40, PERFORMANCE: 60, HIGH_PERFORMANCE: 100 };
  const messagesPerHour = data.messagesPerHour || profileRates[data.speedProfile] || Math.min(100, (data.ratePerMinute || 1) * 60);
  return {
    scheduledAt,
    recipientCount: contactTargets.size + groupTargets.length,
    messagesPerHour,
    fields: {
      name: data.name,
      message: data.message,
      tagFilter: data.tagFilter,
      sendLine: data.sendLine || null,
      campaignType: scheduledAt ? 'SCHEDULED' : (data.campaignType || 'DIRECT'),
      speedProfile: data.speedProfile,
      messagesPerHour,
      ratePerMinute: data.ratePerMinute || Math.max(1, Math.round(messagesPerHour / 60)),
      scheduledAt,
      status: scheduledAt ? 'SCHEDULED' : 'DRAFT'
    },
    recipientsCreate: [...[...contactTargets].map(([contactId, displayName]) => ({ contactId, displayName })), ...groupTargets]
  };
}

router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const data = createCampaignSchema.parse(req.body);
    const input = await campaignInput(req, data);
    const campaign = await prisma.campaign.create({
      data: { organizationId: req.auth.organizationId, ...input.fields, createdByUserId: req.auth.userId, recipients: { create: input.recipientsCreate } },
      include: CAMPAIGN_INCLUDE
    });

    if (input.scheduledAt) campaigns.scheduleCampaign(req.auth.organizationId, campaign.id, input.scheduledAt);

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'campaign.created',
      entityType: 'Campaign',
      entityId: campaign.id,
      metadata: { name: data.name, recipientCount: input.recipientCount, speedProfile: data.speedProfile, messagesPerHour: input.messagesPerHour }
    });

    res.status(201).json({ campaign: campaigns.sanitizeCampaign(campaign, await campaigns.getCounts(campaign.id)) });
  } catch (err) {
    next(err);
  }
});

// Editar: campañas pendientes/programadas, o ya terminadas (completada/cancelada) para editarlas y lanzarlas de nuevo:
// en ese caso vuelven a pendiente con los resultados de envío reiniciados. Las que están enviando o pausadas no se editan.
// Reemplaza datos y destinatarios; el adjunto se conserva salvo que se pida quitarlo o se suba otro con /:id/attachment.
router.patch('/:id', CAMPAIGN_MANAGERS, requireCsrf, async (req, res, next) => {
  try {
    const { removeAttachment, ...body } = req.body || {};
    const data = createCampaignSchema.parse(body);
    const existing = await prisma.campaign.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId }, include: { attachment: true } });
    if (!existing) throw new HttpError(404, 'Campaña no encontrada');
    if (!['DRAFT', 'SCHEDULED', 'COMPLETED', 'CANCELLED'].includes(existing.status)) {
      throw new HttpError(409, 'No se puede editar una campaña que está enviando o pausada. Cancelala primero.');
    }
    const input = await campaignInput(req, data);
    await prisma.$transaction([
      prisma.campaignRecipient.deleteMany({ where: { campaignId: existing.id } }),
      prisma.campaign.update({
        where: { id: existing.id },
        data: { ...input.fields, startedAt: null, completedAt: null, recipients: { create: input.recipientsCreate }, ...(removeAttachment === true ? { attachmentId: null } : {}) }
      })
    ]);
    if (removeAttachment === true && existing.attachment) await removeCampaignAttachment(existing.attachment);
    if (input.scheduledAt) campaigns.scheduleCampaign(req.auth.organizationId, existing.id, input.scheduledAt); else campaigns.pauseCampaign(existing.id);
    await audit(prisma, {
      organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'campaign.updated', entityType: 'Campaign', entityId: existing.id,
      metadata: { name: data.name, recipientCount: input.recipientCount }
    });
    const updated = await prisma.campaign.findUnique({ where: { id: existing.id }, include: CAMPAIGN_INCLUDE });
    res.json({ campaign: campaigns.sanitizeCampaign(updated, await campaigns.getCounts(existing.id)) });
  } catch (err) {
    next(err);
  }
});

async function removeCampaignAttachment(attachment) {
  await prisma.attachment.delete({ where: { id: attachment.id } }).catch(() => {});
  await deleteFile(attachment.storageKey).catch(() => {});
}

// Datos para precargar el asistente al editar o reenviar: destinatarios (contactos y grupos) sin el tope de 500 del detalle.
router.get('/:id/config', async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId }, include: CAMPAIGN_INCLUDE });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id }, select: { contactId: true, groupJid: true, displayName: true, status: true, contact: { select: { phone: true } } }, orderBy: { createdAt: 'asc' } });
    // Los que vinieron de la lista pegada (con nombre propio) vuelven a la lista para poder editarla.
    const pasted = recipients.filter((r) => r.contactId && r.displayName && r.contact?.phone);
    res.json({
      campaign: campaigns.sanitizeCampaign(campaign, await campaigns.getCounts(campaign.id)),
      contactIds: recipients.filter((r) => r.contactId && !pasted.includes(r)).map((r) => r.contactId),
      groupJids: recipients.filter((r) => r.groupJid).map((r) => r.groupJid),
      manualRecipients: pasted.map((r) => ({ phone: r.contact.phone, name: r.displayName }))
    });
  } catch (err) {
    next(err);
  }
});

async function deleteCampaigns(req, ids) {
  const found = await prisma.campaign.findMany({ where: { organizationId: req.auth.organizationId, id: { in: ids } }, include: { attachment: true } });
  const deleted = [];
  const skipped = [];
  for (const campaign of found) {
    if (campaign.status === 'SENDING') { skipped.push({ id: campaign.id, name: campaign.name, reason: 'Está enviando: pausala o cancelala antes de eliminarla' }); continue; }
    campaigns.pauseCampaign(campaign.id);
    // Los mensajes ya enviados quedan en los chats; solo se borra la campaña, sus destinatarios y su adjunto.
    await prisma.campaign.delete({ where: { id: campaign.id } });
    if (campaign.attachment) await removeCampaignAttachment(campaign.attachment);
    deleted.push(campaign.id);
    await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'campaign.deleted', entityType: 'Campaign', entityId: campaign.id, metadata: { name: campaign.name, status: campaign.status } });
  }
  return { deleted, skipped };
}

router.delete('/:id', CAMPAIGN_MANAGERS, requireCsrf, async (req, res, next) => {
  try {
    const result = await deleteCampaigns(req, [req.params.id]);
    if (result.skipped.length) throw new HttpError(409, result.skipped[0].reason);
    if (!result.deleted.length) throw new HttpError(404, 'Campaña no encontrada');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Limpieza en lote del historial: las que están enviando se omiten.
router.post('/bulk-delete', CAMPAIGN_MANAGERS, requireCsrf, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 500) : [];
    if (!ids.length) throw new HttpError(400, 'Elegí al menos una campaña');
    res.json(await deleteCampaigns(req, ids));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attachment', requireCsrf, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Falta el archivo');
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
    if (campaign.status !== 'DRAFT' && campaign.status !== 'SCHEDULED') {
      throw new HttpError(409, 'Solo se puede adjuntar un archivo antes de iniciar el envío');
    }

    const storageKey = await saveFile(req.auth.organizationId, req.file.buffer, extensionFor(req.file.mimetype));
    const attachment = await prisma.attachment.create({
      data: {
        organizationId: req.auth.organizationId,
        fileName: (req.file.originalname || 'archivo').slice(0, 200),
        mimeType: req.file.mimetype,
        size: req.file.size,
        storageKey
      }
    });

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { attachmentId: attachment.id },
      include: CAMPAIGN_INCLUDE
    });

    res.json({ campaign: campaigns.sanitizeCampaign(updated, await campaigns.getCounts(updated.id)) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId },
      include: CAMPAIGN_INCLUDE
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');

    const recipients = await prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id },
      include: { contact: true },
      orderBy: { createdAt: 'asc' },
      take: 500
    });

    res.json({
      campaign: campaigns.sanitizeCampaign(campaign, await campaigns.getCounts(campaign.id)),
      recipients: recipients.map((r) => ({
        id: r.id,
        status: r.status,
        errorMessage: r.errorMessage,
        sentAt: r.sentAt,
        deliveredAt: r.deliveredAt,
        readAt: r.readAt,
        waMessageId: r.waMessageId,
        contact: r.contact
          ? { id: r.contact.id, name: r.displayName || r.contact.name, phone: r.contact.phone, avatarUrl: contactAvatarUrlFor(r.contact.avatarUrl) }
          : { id: r.id, name: r.groupName || 'Grupo', phone: null, avatarUrl: null, isGroup: true }
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/start', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
    if (!['DRAFT', 'SCHEDULED', 'PAUSED'].includes(campaign.status)) {
      throw new HttpError(409, 'La campaña no está en un estado que se pueda iniciar');
    }

    await campaigns.startCampaign(req.auth.organizationId, campaign.id);
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'campaign.started',
      entityType: 'Campaign',
      entityId: campaign.id
    });

    const updated = await prisma.campaign.findUnique({ where: { id: campaign.id }, include: CAMPAIGN_INCLUDE });
    res.json({ campaign: campaigns.sanitizeCampaign(updated, await campaigns.getCounts(campaign.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/pause', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');

    if (campaign.status !== 'SENDING') throw new HttpError(409, 'Solo se puede pausar una campaña que está enviando');
    campaigns.pauseCampaign(campaign.id);
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'PAUSED' },
      include: CAMPAIGN_INCLUDE
    });

    res.json({ campaign: campaigns.sanitizeCampaign(updated, await campaigns.getCounts(campaign.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');

    if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) throw new HttpError(409, 'La campaña ya terminó');
    campaigns.pauseCampaign(campaign.id);
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'CANCELLED' },
      include: CAMPAIGN_INCLUDE
    });

    res.json({ campaign: campaigns.sanitizeCampaign(updated, await campaigns.getCounts(campaign.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/retry-failed', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
    if (!['COMPLETED', 'PAUSED'].includes(campaign.status)) {
      throw new HttpError(409, 'Solo se pueden reintentar fallidos de una campaña completada o pausada');
    }

    await campaigns.retryFailed(req.auth.organizationId, campaign.id);
    const updated = await prisma.campaign.findUnique({ where: { id: campaign.id }, include: CAMPAIGN_INCLUDE });
    res.json({ campaign: campaigns.sanitizeCampaign(updated, await campaigns.getCounts(campaign.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resend', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
    if (['DRAFT', 'SCHEDULED', 'SENDING'].includes(campaign.status)) {
      throw new HttpError(409, 'La campaña todavía está activa o pendiente de iniciar');
    }

    await campaigns.resendCampaign(req.auth.organizationId, campaign.id);
    const updated = await prisma.campaign.findUnique({ where: { id: campaign.id }, include: CAMPAIGN_INCLUDE });
    res.json({ campaign: campaigns.sanitizeCampaign(updated, await campaigns.getCounts(campaign.id)) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
