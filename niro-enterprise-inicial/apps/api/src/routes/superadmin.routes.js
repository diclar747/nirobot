const express = require('express');
const { prisma } = require('../lib/prisma');
const { hashPassword, generateTemporaryPassword } = require('../lib/passwords');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { createOrganizationSchema, updateOrganizationSchema } = require('../validation/superadmin.validation');
const { HttpError } = require('../lib/errors');

const router = express.Router();

router.use(requireAuth, requireRole('SUPERADMIN'));

function sanitizeOrg(org) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    active: org.active,
    planTier: org.planTier,
    maxUsers: org.maxUsers,
    createdAt: org.createdAt,
    userCount: org._count ? org._count.users : undefined,
    settings: org.settings ? { welcomeMessage: org.settings.welcomeMessage, aiEnabled: org.settings.aiEnabled } : null
  };
}

router.get('/organizations', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));

    const [organizations, total] = await Promise.all([
      prisma.organization.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { settings: true, _count: { select: { users: true } } }
      }),
      prisma.organization.count()
    ]);

    res.json({ organizations: organizations.map(sanitizeOrg), total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

router.post('/organizations', requireCsrf, async (req, res, next) => {
  try {
    const data = createOrganizationSchema.parse(req.body);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: data.name,
            slug: data.slug,
            planTier: data.planTier || 'basic',
            maxUsers: data.maxUsers || 20,
            settings: { create: {} }
          },
          include: { settings: true }
        });
        const owner = await tx.user.create({
          data: {
            organizationId: organization.id,
            name: data.ownerName,
            email: data.ownerEmail,
            passwordHash,
            role: 'OWNER',
            mustChangePassword: true
          }
        });
        return { organization, owner };
      });
    } catch (err) {
      if (err.code === 'P2002') {
        const field = Array.isArray(err.meta?.target) ? err.meta.target[0] : err.meta?.target;
        throw new HttpError(409, field === 'email' ? 'Ese email de propietario ya está en uso' : 'Ese slug ya está en uso');
      }
      throw err;
    }

    await audit(prisma, {
      organizationId: created.organization.id,
      actorUserId: req.auth.userId,
      action: 'organization.created',
      entityType: 'Organization',
      entityId: created.organization.id,
      metadata: { name: data.name, slug: data.slug, ownerEmail: data.ownerEmail }
    });

    res.status(201).json({
      organization: sanitizeOrg(created.organization),
      owner: { id: created.owner.id, name: created.owner.name, email: created.owner.email, temporaryPassword }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/organizations/:id', async (req, res, next) => {
  try {
    const organization = await prisma.organization.findUnique({
      where: { id: req.params.id },
      include: { settings: true, _count: { select: { users: true } } }
    });
    if (!organization) throw new HttpError(404, 'Organización no encontrada');
    res.json({ organization: sanitizeOrg(organization) });
  } catch (err) {
    next(err);
  }
});

router.patch('/organizations/:id', requireCsrf, async (req, res, next) => {
  try {
    const data = updateOrganizationSchema.parse(req.body);
    const existing = await prisma.organization.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, 'Organización no encontrada');

    const organization = await prisma.organization.update({
      where: { id: req.params.id },
      data,
      include: { settings: true, _count: { select: { users: true } } }
    });

    let action = 'organization.updated';
    if (typeof data.active === 'boolean' && data.active !== existing.active) {
      action = data.active ? 'organization.activated' : 'organization.suspended';
    }

    await audit(prisma, {
      organizationId: organization.id,
      actorUserId: req.auth.userId,
      action,
      entityType: 'Organization',
      entityId: organization.id,
      metadata: data
    });

    res.json({ organization: sanitizeOrg(organization) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
