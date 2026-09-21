const express = require('express');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireCsrf } = require('../middleware/auth');
const { requirePermission } = require('../lib/permissions');
const { HttpError } = require('../lib/errors');

const router = express.Router();
router.use(requireAuth, (req, _res, next) => (req.auth.organizationId ? next() : next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'))));

const isAdmin = (req) => ['OWNER', 'ADMIN'].includes(req.auth.role);

function normalizeShortcut(value) {
  return String(value || '').trim().replace(/^\/+/, '').toLowerCase().replace(/\s+/g, '-');
}

function parseBody(body, { partial = false } = {}) {
  const data = {};
  const has = (k) => typeof body?.[k] !== 'undefined';
  if (!partial || has('shortcut')) {
    const shortcut = normalizeShortcut(body?.shortcut);
    if (!/^[a-z0-9áéíóúüñ_-]{1,30}$/.test(shortcut)) throw new HttpError(400, 'El atajo debe tener de 1 a 30 letras, números o guiones (sin espacios)');
    data.shortcut = shortcut;
  }
  if (!partial || has('title')) {
    const title = String(body?.title ?? '').trim();
    if (title.length < 1 || title.length > 80) throw new HttpError(400, 'El título debe tener entre 1 y 80 caracteres');
    data.title = title;
  }
  if (!partial || has('content')) {
    const content = String(body?.content ?? '').replace(/\r\n/g, '\n').trim();
    if (content.length < 1 || content.length > 4000) throw new HttpError(400, 'El mensaje debe tener entre 1 y 4000 caracteres');
    data.content = content;
  }
  if (has('shared')) data.shared = Boolean(body.shared);
  return data;
}

function present(reply, userId) {
  return {
    id: reply.id, shortcut: reply.shortcut, title: reply.title, content: reply.content, shared: reply.shared,
    mine: reply.createdByUserId === userId, usageCount: reply.usageCount, lastUsedAt: reply.lastUsedAt,
    createdBy: reply.createdBy ? { id: reply.createdBy.id, name: reply.createdBy.name } : null
  };
}

const INCLUDE = { createdBy: { select: { id: true, name: true } } };

// Visibles: las compartidas con el equipo + las propias.
router.get('/', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().replace(/^\//, '') : '';
    const replies = await prisma.quickReply.findMany({
      where: {
        organizationId: req.auth.organizationId,
        OR: [{ shared: true }, { createdByUserId: req.auth.userId }],
        ...(q ? { AND: [{ OR: [{ shortcut: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }, { content: { contains: q, mode: 'insensitive' } }] }] } : {})
      },
      include: INCLUDE,
      orderBy: [{ usageCount: 'desc' }, { title: 'asc' }],
      take: 300
    });
    res.json({ quickReplies: replies.map((r) => present(r, req.auth.userId)) });
  } catch (err) { next(err); }
});

router.post('/', requirePermission('quickReplies'), requireCsrf, async (req, res, next) => {
  try {
    const data = parseBody(req.body);
    try {
      const reply = await prisma.quickReply.create({ data: { ...data, organizationId: req.auth.organizationId, createdByUserId: req.auth.userId }, include: INCLUDE });
      await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'quick_reply.created', entityType: 'QuickReply', entityId: reply.id, metadata: { shortcut: reply.shortcut } });
      res.status(201).json({ quickReply: present(reply, req.auth.userId) });
    } catch (err) {
      if (err.code === 'P2002') throw new HttpError(409, `Ya existe una respuesta rápida con el atajo /${data.shortcut}`);
      throw err;
    }
  } catch (err) { next(err); }
});

async function loadEditable(req) {
  const reply = await prisma.quickReply.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
  if (!reply) throw new HttpError(404, 'Respuesta rápida no encontrada');
  if (reply.createdByUserId !== req.auth.userId && !isAdmin(req)) throw new HttpError(403, 'Solo quien la creó o un administrador puede modificarla');
  return reply;
}

router.patch('/:id', requirePermission('quickReplies'), requireCsrf, async (req, res, next) => {
  try {
    const existing = await loadEditable(req);
    const data = parseBody(req.body, { partial: true });
    try {
      const reply = await prisma.quickReply.update({ where: { id: existing.id }, data, include: INCLUDE });
      res.json({ quickReply: present(reply, req.auth.userId) });
    } catch (err) {
      if (err.code === 'P2002') throw new HttpError(409, `Ya existe una respuesta rápida con el atajo /${data.shortcut}`);
      throw err;
    }
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('quickReplies'), requireCsrf, async (req, res, next) => {
  try {
    const existing = await loadEditable(req);
    await prisma.quickReply.delete({ where: { id: existing.id } });
    await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'quick_reply.deleted', entityType: 'QuickReply', entityId: existing.id, metadata: { shortcut: existing.shortcut } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Cuenta el uso para ordenar primero las más usadas.
router.post('/:id/use', requireCsrf, async (req, res, next) => {
  try {
    await prisma.quickReply.updateMany({
      where: { id: req.params.id, organizationId: req.auth.organizationId, OR: [{ shared: true }, { createdByUserId: req.auth.userId }] },
      data: { usageCount: { increment: 1 }, lastUsedAt: new Date() }
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
