const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { resolvePath } = require('../lib/storage');
const { safeDownloadName } = require('../lib/attachments');
const statuses = require('../lib/whatsappStatus');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext);
router.use(requirePermission('statuses'));

router.get('/', async (req, res, next) => {
  try {
    res.json({ groups: await statuses.listActive(req.auth.organizationId) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/media', async (req, res, next) => {
  try {
    const status = await prisma.whatsappStatus.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId, expiresAt: { gt: new Date() } }
    });
    if (!status || !status.storageKey) throw new HttpError(404, 'Estado no encontrado o vencido');
    res.setHeader('Content-Type', status.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${safeDownloadName(status.id)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(resolvePath(status.storageKey), (err) => { if (err && !res.headersSent) next(new HttpError(404, 'Archivo no encontrado')); });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
