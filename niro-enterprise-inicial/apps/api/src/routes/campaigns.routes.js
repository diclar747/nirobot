const express = require('express');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { createCampaignSchema } = require('../validation/campaigns.validation');
const { upload } = require('../middleware/upload');
const { saveFile } = require('../lib/storage');
const { extensionFor } = require('../lib/attachments');
const campaigns = require('../lib/campaigns');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext);

const CAMPAIGN_INCLUDE = { attachment: true, createdBy: { select: { id: true, name: true } } };

router.get('/', async (req, res, next) => {
  try {
    const list = await prisma.campaign.findMany({
      where: { organizationId: req.auth.organizationId },
      include: CAMPAIGN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    const withCounts = await Promise.all(
      list.map(async (c) => campaigns.sanitizeCampaign(c, await campaigns.getCounts(c.id)))
    );
    res.json({ campaigns: withCounts });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
  try {
    const data = createCampaignSchema.parse(req.body);
    const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
    if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
      throw new HttpError(400, 'La fecha de programación debe estar en el futuro');
    }

    const recipients = await prisma.contact.findMany({
      where: {
        organizationId: req.auth.organizationId,
        phone: { not: null },
        OR: [
          ...(data.contactIds.length > 0 ? [{ id: { in: data.contactIds } }] : []),
          ...(data.tagFilter.length > 0 ? [{ tags: { hasSome: data.tagFilter } }] : [])
        ]
      },
      select: { id: true }
    });
    if (recipients.length === 0) {
      throw new HttpError(400, 'Ningún contacto seleccionado tiene un teléfono registrado');
    }

    const profileRates = { CONSERVATIVE: 10, BALANCED: 40, PERFORMANCE: 60, HIGH_PERFORMANCE: 100 };
    const messagesPerHour = data.messagesPerHour || profileRates[data.speedProfile] || Math.min(100, (data.ratePerMinute || 1) * 60);

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: req.auth.organizationId,
        name: data.name,
        message: data.message,
        tagFilter: data.tagFilter,
        sendLine: data.sendLine || null,
        campaignType: scheduledAt ? 'SCHEDULED' : (data.campaignType || 'DIRECT'),
        speedProfile: data.speedProfile,
        messagesPerHour,
        ratePerMinute: data.ratePerMinute || Math.max(1, Math.round(messagesPerHour / 60)),
        scheduledAt,
        status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
        createdByUserId: req.auth.userId,
        recipients: {
          create: recipients.map((c) => ({ contactId: c.id }))
        }
      },
      include: CAMPAIGN_INCLUDE
    });

    if (scheduledAt) campaigns.scheduleCampaign(req.auth.organizationId, campaign.id, scheduledAt);

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'campaign.created',
      entityType: 'Campaign',
      entityId: campaign.id,
      metadata: { name: data.name, recipientCount: recipients.length, speedProfile: data.speedProfile, messagesPerHour }
    });

    res.status(201).json({ campaign: campaigns.sanitizeCampaign(campaign, await campaigns.getCounts(campaign.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attachment', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, upload.single('file'), async (req, res, next) => {
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
        contact: { id: r.contact.id, name: r.contact.name, phone: r.contact.phone, avatarUrl: r.contact.avatarUrl }
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/start', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
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

router.post('/:id/pause', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');

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

router.post('/:id/cancel', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');

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

router.post('/:id/retry-failed', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId }
    });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');

    await campaigns.retryFailed(req.auth.organizationId, campaign.id);
    const updated = await prisma.campaign.findUnique({ where: { id: campaign.id }, include: CAMPAIGN_INCLUDE });
    res.json({ campaign: campaigns.sanitizeCampaign(updated, await campaigns.getCounts(campaign.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resend', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), requireCsrf, async (req, res, next) => {
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
