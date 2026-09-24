const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { HttpError } = require('../lib/errors');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { apiKeyNameSchema } = require('../validation/api.validation');
const { createSecret, sanitizeApiKey } = require('../lib/apiKeys');

const router = express.Router();

router.use(requireAuth, requireOrgContext);
router.use('/api-keys', requirePermission('developers'));

const KEY_INCLUDE = {
  createdBy: { select: { id: true, name: true, email: true } },
  _count: { select: { messages: true } }
};

router.get('/api-keys', async (req, res, next) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { organizationId: req.auth.organizationId },
      include: KEY_INCLUDE,
      orderBy: { createdAt: 'desc' }
    });
    res.json({ apiKeys: keys.map(sanitizeApiKey) });
  } catch (err) {
    next(err);
  }
});

router.post('/api-keys', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const data = apiKeyNameSchema.parse(req.body);
    const generated = createSecret();
    const key = await prisma.apiKey.create({
      data: {
        organizationId: req.auth.organizationId,
        createdByUserId: req.auth.userId,
        name: data.name,
        keyPrefix: generated.keyPrefix,
        keyHash: generated.keyHash,
        scopes: [
          'messages:send', 'messages:read', 'sessions:read',
          'status:send', 'status:read',
          'conversations:read', 'conversations:write',
          'contacts:read', 'contacts:write',
          'sms:send', 'sms:read',
          'webhooks:manage'
        ]
      },
      include: KEY_INCLUDE
    });
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'api_key.created',
      entityType: 'ApiKey',
      entityId: key.id,
      metadata: { name: key.name, scopes: key.scopes }
    });
    res.status(201).json({ apiKey: sanitizeApiKey(key), secret: generated.secret, warning: 'Guardá esta clave ahora. Por seguridad no volveremos a mostrarla.' });
  } catch (err) {
    next(err);
  }
});

router.delete('/api-keys/:id', requireCsrf, async (req, res, next) => {
  try {
    const key = await prisma.apiKey.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!key) throw new HttpError(404, 'API key no encontrada');
    if (key.createdByUserId !== req.auth.userId && !['OWNER', 'ADMIN'].includes(req.auth.role)) {
      throw new HttpError(403, 'Solo quien creó la clave o un administrador puede revocarla');
    }
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: key.revokedAt || new Date() } });
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'api_key.revoked',
      entityType: 'ApiKey',
      entityId: key.id
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
