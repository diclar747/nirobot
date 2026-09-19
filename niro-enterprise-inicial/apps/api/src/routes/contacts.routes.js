const express = require('express');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireCsrf } = require('../middleware/auth');
const { contactSchema } = require('../validation/conversations.validation');
const { HttpError } = require('../lib/errors');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext);

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

    const { name, phone, email, tags, avatarUrl, callConsentStatus, callConsentAt, callConsentSource, callOptedOutAt, callOptOutSource } = req.body;
    const data = {};
    if (typeof name !== 'undefined') data.name = name;
    if (typeof phone !== 'undefined') data.phone = phone;
    if (typeof email !== 'undefined') data.email = email;
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
