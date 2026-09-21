const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { statusUpload, prepareStatusMedia } = require('../lib/statusMedia');
const { saveFile, resolvePath, deleteFile } = require('../lib/storage');
const { extensionFor, normalizeMimeType } = require('../lib/attachments');
const whatsapp = require('../lib/whatsapp');
const posts = require('../lib/statusPosts');

const router = express.Router();
const MIN_LEAD_MS = 30 * 1000;

router.use(requireAuth, (req, _res, next) => {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}, requirePermission('statuses'));

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

const createSchema = z.object({
  contentType: z.enum(['text', 'image', 'video']),
  textContent: z.string().max(700).optional(),
  caption: z.string().max(700).optional(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fontStyle: z.coerce.number().int().min(0).max(5).optional(),
  audienceType: z.enum(['ALL', 'TAG', 'CUSTOM']),
  audienceTags: list,
  audienceContactIds: list,
  mode: z.enum(['NOW', 'SCHEDULED', 'DRAFT']).default('NOW'),
  scheduledAt: z.string().min(10).optional()
});

router.get('/metrics', async (req, res, next) => {
  try {
    res.json({ metrics: await posts.metrics(req.auth.organizationId), connected: whatsapp.getStatus(req.auth.organizationId).status === 'connected', maxAudience: posts.MAX_AUDIENCE });
  } catch (err) { next(err); }
});

router.get('/audience-preview', async (req, res, next) => {
  try {
    const parsed = z.object({ audienceType: z.enum(['ALL', 'TAG', 'CUSTOM']), audienceTags: list, audienceContactIds: list }).parse({
      audienceType: req.query.audienceType, audienceTags: req.query.audienceTags, audienceContactIds: req.query.audienceContactIds
    });
    const { count } = await posts.resolveAudience(req.auth.organizationId, parsed);
    res.json({ count, max: posts.MAX_AUDIENCE, tooLarge: count > posts.MAX_AUDIENCE });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = await prisma.whatsappStatusPost.findMany({
      where: { organizationId: req.auth.organizationId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    // Cuántas personas vieron y reaccionaron a cada estado publicado.
    const ids = rows.map((row) => row.waMessageId).filter(Boolean);
    const grouped = ids.length ? await prisma.whatsappStatusView.groupBy({ by: ['waMessageId'], where: { organizationId: req.auth.organizationId, waMessageId: { in: ids } }, _count: { viewedAt: true, reaction: true } }) : [];
    const counts = new Map(grouped.map((row) => [row.waMessageId, { viewCount: row._count.viewedAt, reactionCount: row._count.reaction }]));
    res.json({ posts: rows.map((row) => ({ ...posts.sanitizePost(row), viewCount: counts.get(row.waMessageId)?.viewCount || 0, reactionCount: counts.get(row.waMessageId)?.reactionCount || 0 })) });
  } catch (err) { next(err); }
});

// Quién vio (y quién reaccionó a) un estado publicado: la misma lista que muestra el teléfono, ordenada por lo más reciente.
router.get('/:id/views', async (req, res, next) => {
  try {
    const post = await prisma.whatsappStatusPost.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId }, select: { id: true, waMessageId: true, audienceCount: true, publishedAt: true, expiresAt: true } });
    if (!post) throw new HttpError(404, 'Publicación no encontrada');
    if (!post.waMessageId) return res.json({ views: [], counts: { views: 0, reactions: 0 }, audienceCount: post.audienceCount });
    const statusViews = require('../lib/statusViews');
    const rows = await prisma.whatsappStatusView.findMany({ where: { organizationId: req.auth.organizationId, waMessageId: post.waMessageId }, orderBy: [{ viewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }] });
    res.json({ views: rows.map(statusViews.sanitizeView), counts: await statusViews.countsFor(req.auth.organizationId, post.waMessageId), audienceCount: post.audienceCount, publishedAt: post.publishedAt, expiresAt: post.expiresAt });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const post = await prisma.whatsappStatusPost.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId }, include: { attempts: { orderBy: { attemptNumber: 'asc' } } } });
    if (!post) throw new HttpError(404, 'Publicación no encontrada');
    res.json({ post: posts.sanitizePost(post) });
  } catch (err) { next(err); }
});

router.get('/:id/media', async (req, res, next) => {
  try {
    const post = await prisma.whatsappStatusPost.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!post || !post.mediaStorageKey) throw new HttpError(404, 'Archivo no encontrado');
    res.setHeader('Content-Type', post.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(resolvePath(post.mediaStorageKey), (err) => { if (err && !res.headersSent) next(new HttpError(404, 'Archivo no encontrado')); });
  } catch (err) { next(err); }
});

router.post('/', requireCsrf, statusUpload.single('file'), async (req, res, next) => {
  let storageKey = null;
  try {
    const data = createSchema.parse(req.body);
    const organizationId = req.auth.organizationId;

    if (data.contentType === 'text' && !String(data.textContent || '').trim()) throw new HttpError(400, 'Escribí el texto del estado');
    if (data.contentType !== 'text' && !req.file) throw new HttpError(400, data.contentType === 'video' ? 'Falta el video del estado' : 'Falta la imagen del estado');

    let scheduledAt = null;
    if (data.mode === 'SCHEDULED') {
      scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
      if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) throw new HttpError(400, 'Indicá la fecha y hora de publicación');
      if (scheduledAt.getTime() < Date.now() + MIN_LEAD_MS) throw new HttpError(400, 'La fecha de programación debe estar en el futuro');
    }

    const audience = await posts.resolveAudience(organizationId, data);
    if (audience.count === 0) throw new HttpError(400, 'La audiencia seleccionada no tiene contactos con un número válido');
    if (audience.count > posts.MAX_AUDIENCE) throw new HttpError(400, `La audiencia (${audience.count}) supera el máximo de ${posts.MAX_AUDIENCE} contactos`);

    if (data.mode === 'NOW' && whatsapp.getStatus(organizationId).status !== 'connected') {
      throw new HttpError(409, 'WhatsApp no está conectado. Reconectá la línea para publicar.');
    }

    let mimeType = null;
    if (data.contentType !== 'text') {
      const media = await prepareStatusMedia(req.file, data.contentType);
      mimeType = media.mimeType;
      storageKey = await saveFile(organizationId, media.buffer, extensionFor(mimeType));
    }

    const post = await prisma.whatsappStatusPost.create({
      data: {
        organizationId, createdByUserId: req.auth.userId, contentType: data.contentType,
        textContent: data.contentType === 'text' ? data.textContent.trim() : null,
        caption: data.contentType !== 'text' && data.caption ? data.caption.trim() : null,
        mediaStorageKey: storageKey, mimeType,
        backgroundColor: data.contentType === 'text' ? (data.backgroundColor || '#075E54') : null,
        fontStyle: data.contentType === 'text' ? (data.fontStyle ?? 0) : null,
        audienceType: data.audienceType, audienceTags: data.audienceTags, audienceContactIds: data.audienceContactIds,
        audienceCount: audience.count, publicationMode: data.mode === 'DRAFT' ? 'NOW' : data.mode, scheduledAt,
        status: data.mode === 'NOW' ? 'processing' : data.mode === 'SCHEDULED' ? 'scheduled' : 'draft',
        nextAttemptAt: data.mode === 'SCHEDULED' ? scheduledAt : null
      }
    });
    storageKey = null;
    await audit(prisma, { organizationId, actorUserId: req.auth.userId, action: 'status_post.created', entityType: 'WhatsappStatusPost', entityId: post.id, metadata: { mode: data.mode, contentType: data.contentType, audience: audience.count } });

    // Immediate posts are sent in the background; the result arrives through the socket event.
    if (data.mode === 'NOW') posts.publishClaimed(post.id).catch((err) => console.error('[status-posts] publish failed', err));
    res.status(201).json({ post: posts.sanitizePost(post) });
  } catch (err) {
    if (storageKey) await deleteFile(storageKey);
    next(err);
  }
});

async function loadOwned(req) {
  const post = await prisma.whatsappStatusPost.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
  if (!post) throw new HttpError(404, 'Publicación no encontrada');
  return post;
}

async function publishHandler(req, res, next) {
  try {
    const post = await loadOwned(req);
    if (!['draft', 'failed'].includes(post.status)) throw new HttpError(409, 'Solo se puede publicar un borrador o reintentar una publicación fallida');
    if (whatsapp.getStatus(req.auth.organizationId).status !== 'connected') throw new HttpError(409, 'WhatsApp no está conectado. Reconectá la línea para publicar.');
    await prisma.whatsappStatusPost.update({ where: { id: post.id }, data: { retryCount: 0, publicationMode: 'NOW', errorMessage: null } });
    const started = await posts.publishNow(post.id);
    if (!started) throw new HttpError(409, 'La publicación ya se está procesando');
    res.status(202).json({ post: posts.sanitizePost(started) });
  } catch (err) { next(err); }
}
router.post('/:id/publish', requireCsrf, publishHandler);
router.post('/:id/retry', requireCsrf, publishHandler);

router.post('/:id/duplicate', requireCsrf, async (req, res, next) => {
  try {
    const copy = await posts.duplicatePost(req.auth.organizationId, req.params.id, req.auth.userId);
    if (!copy) throw new HttpError(404, 'Publicación no encontrada');
    res.status(201).json({ post: posts.sanitizePost(copy) });
  } catch (err) { next(err); }
});

router.post('/:id/cancel', requireCsrf, async (req, res, next) => {
  try {
    const post = await loadOwned(req);
    if (!['scheduled', 'draft', 'failed'].includes(post.status)) throw new HttpError(409, 'Solo se puede cancelar una publicación pendiente');
    res.json({ post: posts.sanitizePost(await posts.removePost(req.auth.organizationId, post.id)) });
  } catch (err) { next(err); }
});

router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const removed = await posts.removePost(req.auth.organizationId, req.params.id);
    if (!removed) throw new HttpError(404, 'Publicación no encontrada');
    await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'status_post.deleted', entityType: 'WhatsappStatusPost', entityId: removed.id });
    res.json({ post: posts.sanitizePost(removed) });
  } catch (err) {
    if (err instanceof posts.StatusPostError) return next(new HttpError(409, err.message));
    next(err);
  }
});

module.exports = router;
