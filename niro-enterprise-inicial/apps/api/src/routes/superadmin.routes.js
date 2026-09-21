const express = require('express');
const { prisma } = require('../lib/prisma');
const { hashPassword, generateTemporaryPassword } = require('../lib/passwords');
const { audit } = require('../lib/audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { createOrganizationSchema, updateOrganizationSchema } = require('../validation/superadmin.validation');
const { HttpError } = require('../lib/errors');
const whatsapp = require('../lib/whatsapp');
const billing = require('../lib/billing');

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
      if (!data.active) {
        // A suspended organization keeps no live transport: stop its WhatsApp socket (bot, sends,
        // calls) and pause running campaigns. Credentials are kept so reactivation is seamless.
        await whatsapp.suspendSession(existing.id).catch((err) => console.error('[superadmin] suspend whatsapp', err));
        await prisma.campaign.updateMany({ where: { organizationId: existing.id, status: 'SENDING' }, data: { status: 'PAUSED' } });
        await prisma.callCampaign.updateMany({ where: { organizationId: existing.id, status: 'RUNNING' }, data: { status: 'PAUSED' } });
      } else if (whatsapp.hasStoredSession(existing.id)) {
        whatsapp.connect(existing.id).catch((err) => console.error('[superadmin] reconnect whatsapp', err));
      }
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


// ---------- Facturación / clientes ----------
router.get('/billing/overview', async (_req, res, next) => {
  try {
    const orgs = await prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        plan: { select: { id: true, name: true, maxAgents: true } },
        _count: { select: { users: true, contacts: true } },
        users: { where: { role: 'OWNER' }, select: { name: true, email: true }, take: 1 },
        billingPayments: { where: { status: { in: ['paid', 'pending'] } }, orderBy: { createdAt: 'desc' }, take: 5 },
        callAccounts: { select: { phoneNumber: true }, take: 1 }
      }
    });
    const now = new Date();
    const customers = orgs.filter((o) => o.active || o.billingPayments.length || o.callAccounts.length).map((o) => {
      const access = billing.accessFor(o, now);
      const lastPaid = o.billingPayments.find((p) => p.status === 'paid');
      const hasPending = o.billingPayments.some((p) => p.status === 'pending');
      let bucket = access.state; // trial | active | expired | exempt
      return {
        id: o.id, name: o.name, active: o.active, createdAt: o.createdAt,
        phone: o.callAccounts[0]?.phoneNumber || null,
        owner: o.users[0] || null,
        users: o._count.users, contacts: o._count.contacts,
        state: bucket, hasPending, plan: o.plan ? { id: o.plan.id, name: o.plan.name, maxAgents: o.plan.maxAgents } : null,
        trialEndsAt: access.trialEndsAt, paidUntil: access.paidUntil,
        lastPayment: lastPaid ? { amount: lastPaid.amount, paidAt: lastPaid.paidAt } : null
      };
    });
    const paidAgg = await prisma.billingPayment.aggregate({ where: { status: 'paid' }, _sum: { amount: true }, _count: true });
    const monthAgg = await prisma.billingPayment.aggregate({ where: { status: 'paid', paidAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } }, _sum: { amount: true } });
    const count = (state) => customers.filter((c) => c.state === state).length;
    res.json({
      summary: { total: customers.length, active: count('active'), trial: count('trial'), expired: count('expired'), exempt: count('exempt'), pending: customers.filter((c) => c.hasPending && c.state !== 'active').length, revenueTotal: paidAgg._sum.amount || 0, revenueMonth: monthAgg._sum.amount || 0, payments: paidAgg._count, priceGs: billing.PLAN_PRICE_GS },
      customers
    });
  } catch (err) { next(err); }
});

router.get('/billing/organizations/:id/users', async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({ where: { organizationId: req.params.id }, select: { id: true, name: true, email: true, role: true, active: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    const payments = await prisma.billingPayment.findMany({ where: { organizationId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 20 });
    res.json({ users, payments: payments.map((p) => ({ id: p.id, amount: p.amount, status: p.status, paymentMethod: p.paymentMethod, paidAt: p.paidAt, createdAt: p.createdAt })) });
  } catch (err) { next(err); }
});

router.post('/billing/organizations/:id/grant', requireCsrf, async (req, res, next) => {
  try {
    const org = await prisma.organization.findUnique({ where: { id: req.params.id } });
    if (!org) throw new HttpError(404, 'Organización no encontrada');
    const days = Math.min(365, Math.max(1, Number(req.body?.days) || 30));
    const base = org.paidUntil && new Date(org.paidUntil) > new Date() ? new Date(org.paidUntil) : new Date();
    let planId;
    if (req.body?.planId) {
      const plan = await prisma.plan.findUnique({ where: { id: String(req.body.planId) } });
      if (!plan) throw new HttpError(404, 'Plan no encontrado');
      planId = plan.id;
    }
    const updated = await prisma.organization.update({ where: { id: org.id }, data: { paidUntil: new Date(base.getTime() + days * 24 * 3600 * 1000), ...(planId ? { planId } : {}) } });
    await audit(prisma, { organizationId: org.id, actorUserId: req.auth.userId, action: 'billing.granted', entityType: 'Organization', entityId: org.id, metadata: { days } });
    res.json({ paidUntil: updated.paidUntil });
  } catch (err) { next(err); }
});

router.post('/billing/organizations/:id/trial', requireCsrf, async (req, res, next) => {
  try {
    const hours = Math.min(24 * 30, Math.max(1, Number(req.body?.hours) || 24));
    const updated = await prisma.organization.update({ where: { id: req.params.id }, data: { trialEndsAt: new Date(Date.now() + hours * 3600 * 1000) } });
    await audit(prisma, { organizationId: updated.id, actorUserId: req.auth.userId, action: 'billing.trial_extended', entityType: 'Organization', entityId: updated.id, metadata: { hours } });
    res.json({ trialEndsAt: updated.trialEndsAt });
  } catch (err) { next(err); }
});

router.post('/billing/organizations/:id/exempt', requireCsrf, async (req, res, next) => {
  try {
    const updated = await prisma.organization.update({ where: { id: req.params.id }, data: { billingExempt: Boolean(req.body?.exempt) } });
    await audit(prisma, { organizationId: updated.id, actorUserId: req.auth.userId, action: updated.billingExempt ? 'billing.exempted' : 'billing.exempt_removed', entityType: 'Organization', entityId: updated.id });
    res.json({ billingExempt: updated.billingExempt });
  } catch (err) { next(err); }
});

router.get('/notices', async (_req, res, next) => {
  try {
    const notices = await prisma.platformNotice.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { organization: { select: { name: true } }, _count: { select: { reads: true } } } });
    res.json({ notices: notices.map((n) => ({ id: n.id, audience: n.audience, organizationName: n.organization?.name || null, title: n.title, body: n.body, level: n.level, createdAt: n.createdAt, reads: n._count.reads })) });
  } catch (err) { next(err); }
});

router.post('/notices', requireCsrf, async (req, res, next) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 120);
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    const audience = ['all', 'trial', 'active', 'expired', 'org'].includes(req.body?.audience) ? req.body.audience : 'all';
    const level = ['info', 'warning', 'success'].includes(req.body?.level) ? req.body.level : 'info';
    const organizationId = audience === 'org' ? String(req.body?.organizationId || '') : null;
    if (!title || !body) throw new HttpError(400, 'Escribí el título y el mensaje del aviso');
    if (audience === 'org' && !(await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } }))) throw new HttpError(404, 'Cliente no encontrado');
    const notice = await prisma.platformNotice.create({ data: { title, body, audience, level, organizationId, createdByUserId: req.auth.userId } });
    try { require('../lib/realtime').emitToAll?.('notice:new', { id: notice.id }); } catch { /* opcional */ }
    res.status(201).json({ notice });
  } catch (err) { next(err); }
});

router.delete('/notices/:id', requireCsrf, async (req, res, next) => {
  try { await prisma.platformNotice.delete({ where: { id: req.params.id } }); res.json({ ok: true }); } catch (err) { next(err); }
});


// ---------- Planes ----------
function parsePlan(body, { partial = false } = {}) {
  const data = {};
  const has = (key) => typeof body?.[key] !== 'undefined';
  if (!partial || has('name')) {
    const name = String(body?.name ?? '').trim();
    if (name.length < 2 || name.length > 40) throw new HttpError(400, 'El nombre del plan debe tener entre 2 y 40 caracteres');
    data.name = name;
  }
  if (!partial || has('priceGs')) {
    const price = Number(body?.priceGs);
    if (!Number.isInteger(price) || price < 1000 || price > 100000000) throw new HttpError(400, 'El precio debe ser un número entero en guaraníes (mínimo 1.000)');
    data.priceGs = price;
  }
  if (!partial || has('maxAgents')) {
    const agents = Number(body?.maxAgents);
    if (!Number.isInteger(agents) || agents < 0 || agents > 1000) throw new HttpError(400, 'Los agentes permitidos deben ser un número entero entre 0 y 1000');
    data.maxAgents = agents;
  }
  if (has('description')) data.description = String(body.description ?? '').trim().slice(0, 200) || null;
  if (has('features')) {
    if (!Array.isArray(body.features)) throw new HttpError(400, 'Las características deben ser una lista');
    data.features = body.features.map((f) => String(f).trim().slice(0, 80)).filter(Boolean).slice(0, 12);
  }
  if (has('active')) data.active = Boolean(body.active);
  if (has('popular')) data.popular = Boolean(body.popular);
  if (has('sortOrder')) {
    const order = Number(body.sortOrder);
    if (!Number.isInteger(order) || order < 0 || order > 1000) throw new HttpError(400, 'El orden debe ser un número entero');
    data.sortOrder = order;
  }
  return data;
}

router.get('/plans', async (_req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { priceGs: 'asc' }], include: { _count: { select: { organizations: true } } } });
    res.json({ plans: plans.map(({ _count, ...p }) => ({ ...p, organizations: _count.organizations })) });
  } catch (err) { next(err); }
});

router.post('/plans', requireCsrf, async (req, res, next) => {
  try {
    const data = parsePlan(req.body);
    if (typeof data.sortOrder === 'undefined') data.sortOrder = (await prisma.plan.count()) + 1;
    const plan = await prisma.plan.create({ data });
    await audit(prisma, { organizationId: null, actorUserId: req.auth.userId, action: 'plan.created', entityType: 'Plan', entityId: plan.id, metadata: data });
    res.status(201).json({ plan });
  } catch (err) { next(err); }
});

router.patch('/plans/:id', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, 'Plan no encontrado');
    const data = parsePlan(req.body, { partial: true });
    const plan = await prisma.plan.update({ where: { id: existing.id }, data });
    // Si cambian los agentes permitidos, los clientes de este plan lo toman al instante (el tope se calcula al agregar usuarios).
    await audit(prisma, { organizationId: null, actorUserId: req.auth.userId, action: 'plan.updated', entityType: 'Plan', entityId: plan.id, metadata: data });
    res.json({ plan });
  } catch (err) { next(err); }
});

router.delete('/plans/:id', requireCsrf, async (req, res, next) => {
  try {
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id }, include: { _count: { select: { organizations: true } } } });
    if (!plan) throw new HttpError(404, 'Plan no encontrado');
    if (plan._count.organizations > 0) {
      throw new HttpError(409, `No se puede eliminar: ${plan._count.organizations} cliente${plan._count.organizations > 1 ? 's usan' : ' usa'} este plan. Desactivalo para que no se pueda contratar, o pasá a esos clientes a otro plan.`);
    }
    await prisma.plan.delete({ where: { id: plan.id } });
    await audit(prisma, { organizationId: null, actorUserId: req.auth.userId, action: 'plan.deleted', entityType: 'Plan', entityId: plan.id, metadata: { name: plan.name } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- SMS: saldo del proveedor, ventas y asignación manual de saldo ----
router.get('/sms/overview', async (_req, res, next) => {
  try {
    const sms = require('../lib/sms');
    const provider = require('../lib/smsProvider');
    let providerInfo = { configured: provider.configured(), balance: null, error: null };
    if (provider.configured()) {
      try { providerInfo = { ...providerInfo, ...(await provider.getBalance()) }; } catch (err) { providerInfo.error = err.message; }
    }
    const [orgs, purchases, messages, sold] = await Promise.all([
      prisma.organization.findMany({ where: { OR: [{ smsBalance: { gt: 0 } }, { smsPurchases: { some: {} } }, { smsMessages: { some: {} } }] }, select: { id: true, name: true, smsBalance: true, active: true } }),
      prisma.smsPurchase.groupBy({ by: ['organizationId', 'source'], where: { status: 'paid' }, _sum: { credits: true, amount: true } }),
      prisma.smsMessage.groupBy({ by: ['organizationId', 'status'], _count: { _all: true } }),
      prisma.smsPurchase.aggregate({ where: { status: 'paid' }, _sum: { credits: true, amount: true } })
    ]);
    const rows = orgs.map((org) => {
      const bought = purchases.filter((p) => p.organizationId === org.id);
      const sent = messages.filter((m) => m.organizationId === org.id && ['SENT', 'DELIVERED'].includes(m.status)).reduce((n, m) => n + m._count._all, 0);
      const failed = messages.filter((m) => m.organizationId === org.id && m.status === 'FAILED').reduce((n, m) => n + m._count._all, 0);
      return { id: org.id, name: org.name, active: org.active, balance: org.smsBalance, sent, failed, creditsCard: bought.filter((p) => p.source === 'CARD').reduce((n, p) => n + (p._sum.credits || 0), 0), creditsAdmin: bought.filter((p) => p.source === 'ADMIN').reduce((n, p) => n + (p._sum.credits || 0), 0) };
    }).sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));
    const owed = rows.reduce((n, r) => n + r.balance, 0);
    res.json({ provider: providerInfo, priceGs: sms.PRICE_GS(), totals: { creditsSold: sold._sum.credits || 0, revenue: sold._sum.amount || 0, customerBalance: owed, sent: rows.reduce((n, r) => n + r.sent, 0), failed: rows.reduce((n, r) => n + r.failed, 0) }, organizations: rows });
  } catch (err) { next(err); }
});

// Asigna (o descuenta, con un número negativo) saldo de SMS a una empresa. Queda en su historial de compras.
router.post('/sms/organizations/:id/credits', requireCsrf, async (req, res, next) => {
  try {
    const sms = require('../lib/sms');
    const org = await prisma.organization.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
    if (!org) throw new HttpError(404, 'Empresa no encontrada');
    const credits = Number(req.body?.credits);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
    const amount = req.body?.amount === undefined || req.body?.amount === null || req.body?.amount === '' ? undefined : Number(req.body.amount);
    const result = await sms.grantCredits(org.id, credits, { userId: req.auth.userId, note, amount });
    await audit(prisma, { organizationId: org.id, actorUserId: req.auth.userId, action: 'sms.credits.assigned', entityType: 'Organization', entityId: org.id, metadata: { credits, note: note || null } });
    res.json({ balance: result.balance, organization: org.name });
  } catch (err) { next(err); }
});

// Registra en Winsap el webhook de entregas (una vez). Después el estado "entregado" o "fallido" llega solo.
router.post('/sms/webhook/register', requireCsrf, async (_req, res, next) => {
  try {
    const provider = require('../lib/smsProvider');
    const origin = (process.env.PUBLIC_APP_URL || String(process.env.WEB_ORIGIN || '').split(',')[0] || '').trim().replace(/\/$/, '');
    if (!origin) throw new HttpError(400, 'Falta configurar PUBLIC_APP_URL');
    const result = await provider.registerWebhook(`${origin}/api/billing/webhook/sms-delivery?token=${provider.webhookToken()}`, billing.webhookSecret());
    res.json({ ok: true, webhookId: result.webhook_id || null });
  } catch (err) { next(err.name === 'SmsProviderError' ? new HttpError(502, err.message) : err); }
});

module.exports = router;
