const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { statusUpload, prepareStatusMedia } = require('../lib/statusMedia');
const { saveFile, deleteFile } = require('../lib/storage');
const { extensionFor, normalizeMimeType } = require('../lib/attachments');
const posts = require('../lib/statusPosts');
const campaigns = require('../lib/statusCampaigns');

const router = express.Router();
const MAX_TOTAL_UPLOAD_BYTES = 300 * 1024 * 1024;
const MIN_LEAD_MS = 30 * 1000;

router.use(requireAuth, requireOrgContext, requirePermission('statuses'));

// Multipart fields arrive as strings: accept JSON arrays, comma lists or real arrays.
const list = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* comma list */ }
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return value;
}, z.array(z.string().min(1).max(60)).max(500));

const jsonField = (schema) => z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}, schema);

const itemSchema = z.object({
  contentType: z.enum(['text', 'image', 'video']),
  textContent: z.string().max(700).optional(),
  caption: z.string().max(700).optional(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fileIndex: z.number().int().min(0).optional()
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  intervalHours: z.coerce.number().int().refine((n) => campaigns.ALLOWED_INTERVALS.includes(n), 'Intervalo no permitido'),
  startAt: z.string().min(10),
  replacePrevious: z.preprocess((v) => v === true || v === 'true', z.boolean()),
  audienceType: z.enum(['ALL', 'TAG', 'CUSTOM']),
  audienceTags: list,
  audienceContactIds: list,
  items: jsonField(z.array(itemSchema).min(1).max(campaigns.MAX_ITEMS))
});

router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.whatsappStatusCampaign.findMany({ where: { organizationId: req.auth.organizationId }, orderBy: { createdAt: 'desc' }, take: 50 });
    res.json({ campaigns: await campaigns.summarize(rows), intervals: campaigns.ALLOWED_INTERVALS, maxItems: campaigns.MAX_ITEMS });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const campaign = await prisma.whatsappStatusCampaign.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
    const items = await prisma.whatsappStatusPost.findMany({ where: { campaignId: campaign.id }, orderBy: { sequence: 'asc' } });
    const [summary] = await campaigns.summarize([campaign]);
    res.json({ campaign: summary, posts: items.map(posts.sanitizePost) });
  } catch (err) { next(err); }
});

router.post('/', requireCsrf, statusUpload.array('files', campaigns.MAX_ITEMS), async (req, res, next) => {
  const savedKeys = [];
  try {
    const data = createSchema.parse(req.body);
    const organizationId = req.auth.organizationId;
    const files = req.files || [];

    const startAt = new Date(data.startAt);
    if (Number.isNaN(startAt.getTime())) throw new HttpError(400, 'Indicá la fecha y hora de la primera publicación');
    if (startAt.getTime() < Date.now() + MIN_LEAD_MS) throw new HttpError(400, 'La primera publicación debe estar en el futuro');

    const usedFiles = new Set();
    data.items.forEach((item, index) => {
      const label = `Publicación ${index + 1}`;
      if (item.contentType === 'text') {
        if (!String(item.textContent || '').trim()) throw new HttpError(400, `${label}: escribí el texto`);
        return;
      }
      const file = files[item.fileIndex];
      if (item.fileIndex === undefined || !file) throw new HttpError(400, `${label}: falta el archivo`);
      if (usedFiles.has(item.fileIndex)) throw new HttpError(400, `${label}: el archivo está repetido`);
      usedFiles.add(item.fileIndex);
      const type = normalizeMimeType(file.mimetype);
      if (item.contentType === 'image' && !type.startsWith('image/')) throw new HttpError(400, `${label}: el archivo no es una imagen`);
      if (item.contentType === 'video' && !type.startsWith('video/')) throw new HttpError(400, `${label}: el archivo no es un video`);
    });
    if (files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_UPLOAD_BYTES) throw new HttpError(413, 'Los archivos de la campaña suman demasiado; subí menos videos a la vez.');

    const audience = await posts.resolveAudience(organizationId, data);
    if (audience.count === 0) throw new HttpError(400, 'La audiencia seleccionada no tiene contactos con un número válido');
    if (audience.count > posts.MAX_AUDIENCE) throw new HttpError(400, `La audiencia (${audience.count}) supera el máximo de ${posts.MAX_AUDIENCE} contactos configurado en el servidor`);

    const rows = [];
    for (const [index, item] of data.items.entries()) {
      let mediaStorageKey = null;
      let mimeType = null;
      if (item.contentType !== 'text') {
        const media = await prepareStatusMedia(files[item.fileIndex], item.contentType);
        mimeType = media.mimeType;
        mediaStorageKey = await saveFile(organizationId, media.buffer, extensionFor(mimeType));
        savedKeys.push(mediaStorageKey);
      }
      const at = campaigns.slotTime(startAt, data.intervalHours, index);
      rows.push({
        organizationId, createdByUserId: req.auth.userId, contentType: item.contentType,
        textContent: item.contentType === 'text' ? item.textContent.trim() : null,
        caption: item.contentType !== 'text' && item.caption ? item.caption.trim() : null,
        mediaStorageKey, mimeType,
        backgroundColor: item.contentType === 'text' ? (item.backgroundColor || '#075E54') : null,
        fontStyle: item.contentType === 'text' ? 0 : null,
        audienceType: data.audienceType, audienceTags: data.audienceTags, audienceContactIds: data.audienceContactIds,
        audienceCount: audience.count, publicationMode: 'SCHEDULED', scheduledAt: at, nextAttemptAt: at,
        status: 'scheduled', sequence: index
      });
    }

    const campaign = await prisma.$transaction(async (tx) => {
      const created = await tx.whatsappStatusCampaign.create({
        data: { organizationId, createdByUserId: req.auth.userId, name: data.name, intervalHours: data.intervalHours, startAt, replacePrevious: data.replacePrevious, totalItems: rows.length }
      });
      await tx.whatsappStatusPost.createMany({ data: rows.map((row) => ({ ...row, campaignId: created.id })) });
      return created;
    });
    savedKeys.length = 0;
    await audit(prisma, { organizationId, actorUserId: req.auth.userId, action: 'status_campaign.created', entityType: 'WhatsappStatusCampaign', entityId: campaign.id, metadata: { items: rows.length, intervalHours: data.intervalHours, audience: audience.count } });
    const [summary] = await campaigns.summarize([campaign]);
    res.status(201).json({ campaign: summary });
  } catch (err) {
    for (const key of savedKeys) await deleteFile(key);
    next(err);
  }
});

function wrap(action, auditName) {
  return async (req, res, next) => {
    try {
      const updated = await action(req.auth.organizationId, req.params.id);
      if (!updated) throw new HttpError(404, 'Campaña no encontrada');
      campaigns.emitCampaign(updated);
      await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: auditName, entityType: 'WhatsappStatusCampaign', entityId: updated.id });
      const [summary] = await campaigns.summarize([updated]);
      res.json({ campaign: summary });
    } catch (err) {
      if (err instanceof posts.StatusPostError) return next(new HttpError(409, err.message));
      next(err);
    }
  };
}

router.post('/:id/pause', requireCsrf, wrap(campaigns.pause, 'status_campaign.paused'));
router.post('/:id/resume', requireCsrf, wrap(campaigns.resume, 'status_campaign.resumed'));
router.post('/:id/cancel', requireCsrf, wrap(campaigns.cancel, 'status_campaign.cancelled'));

module.exports = router;
