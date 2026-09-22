const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { createCampaignSchema } = require('../validation/campaigns.validation');
const { upload } = require('../middleware/upload');
const { saveFile, deleteFile } = require('../lib/storage');
const { extensionFor } = require('../lib/attachments');
const { contactAvatarUrlFor } = require('../lib/avatars');
const campaigns = require('../lib/campaigns');
const whatsapp = require('../lib/whatsapp');
const { findUnknownVariables, PUBLIC_VARIABLES } = require('../lib/campaignVariables');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

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

const CAMPAIGN_MANAGERS = requireRole('OWNER', 'ADMIN', 'SUPERVISOR');

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
  if (recipients.length === 0 && groupTargets.length === 0) {
    throw new HttpError(400, 'Ningún contacto seleccionado tiene un teléfono registrado');
  }

  const profileRates = { CONSERVATIVE: 10, BALANCED: 40, PERFORMANCE: 60, HIGH_PERFORMANCE: 100 };
  const messagesPerHour = data.messagesPerHour || profileRates[data.speedProfile] || Math.min(100, (data.ratePerMinute || 1) * 60);
  return {
    scheduledAt,
    recipientCount: recipients.length + groupTargets.length,
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
    recipientsCreate: [...recipients.map((c) => ({ contactId: c.id })), ...groupTargets]
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
    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id }, select: { contactId: true, groupJid: true, status: true }, orderBy: { createdAt: 'asc' } });
    res.json({
      campaign: campaigns.sanitizeCampaign(campaign, await campaigns.getCounts(campaign.id)),
      contactIds: recipients.filter((r) => r.contactId).map((r) => r.contactId),
      groupJids: recipients.filter((r) => r.groupJid).map((r) => r.groupJid)
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
          ? { id: r.contact.id, name: r.contact.name, phone: r.contact.phone, avatarUrl: contactAvatarUrlFor(r.contact.avatarUrl) }
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
