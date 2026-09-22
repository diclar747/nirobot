const express = require('express');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const billing = require('../lib/billing');

// ---- Cliente (organización): /api/org/billing ----
const router = express.Router();
router.use(requireAuth, requireOrgContext);

function sanitizePayment(p) {
  return { planName: p.planName || null, id: p.id, amount: p.amount, currency: p.currency, status: p.status, paymentUrl: p.paymentUrl, paymentMethod: p.paymentMethod, paidAt: p.paidAt, createdAt: p.createdAt };
}

async function loadOrg(req) {
  const org = await prisma.organization.findUnique({ where: { id: req.auth.organizationId } });
  if (!org) throw new HttpError(404, 'Organización no encontrada');
  return org;
}

router.get('/status', async (req, res, next) => {
  try {
    const org = await loadOrg(req);
    const access = billing.accessFor(org);
    // Agentes y supervisores solo necesitan saber si la cuenta está habilitada: nada de precios ni pagos.
    if (!['OWNER', 'ADMIN'].includes(req.auth.role)) {
      return res.json({ access: { state: access.state, blocked: access.blocked, msLeft: 0, endsAt: null, priceGs: 0, planName: '', planDays: 0 }, payments: [], online: false, seats: null, restricted: true });
    }
    const payments = await prisma.billingPayment.findMany({ where: { organizationId: org.id, status: { in: ['paid', 'pending'] } }, orderBy: { createdAt: 'desc' }, take: 12 });
    res.json({ access: { ...access, msLeft: access.msLeft }, payments: payments.map(sanitizePayment), online: billing.winsapConfigured(), seats: await billing.seatInfo(org.id) });
  } catch (err) { next(err); }
});

router.get('/plans', requireRole('OWNER', 'ADMIN'), async (_req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { priceGs: 'asc' }] });
    res.json({ plans: plans.map((p) => ({ id: p.id, name: p.name, description: p.description, priceGs: p.priceGs, maxAgents: p.maxAgents, features: p.features, popular: p.popular })) });
  } catch (err) { next(err); }
});

router.post('/checkout', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const org = await loadOrg(req);
    const plan = await prisma.plan.findFirst({ where: { id: String(req.body?.planId || ''), active: true } });
    if (!plan) throw new HttpError(400, 'Elegí un plan disponible');
    const user = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { email: true } });
    const payment = await billing.createCheckout(org, user?.email, plan);
    if (!payment.paymentUrl) throw new HttpError(502, 'No se pudo generar el link de pago');
    res.json({ payment: sanitizePayment(payment) });
  } catch (err) { next(err); }
});

// El cliente vuelve del pago (o toca "Ya pagué"): consultamos a Winsap y activamos.
router.post('/verify', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const activated = await billing.syncPendingPayments(req.auth.organizationId).catch((err) => { console.error('[billing] verify', err.message); return 0; });
    const org = await loadOrg(req);
    res.json({ activated, access: billing.accessFor(org) });
  } catch (err) { next(err); }
});

router.get('/notices', async (req, res, next) => {
  try {
    const org = await loadOrg(req);
    const state = billing.accessFor(org).state;
    const notices = await prisma.platformNotice.findMany({
      where: { OR: [{ audience: 'all' }, { audience: state }, { audience: 'org', organizationId: org.id }], createdAt: { gt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
      orderBy: { createdAt: 'desc' }, take: 20,
      include: { reads: { where: { userId: req.auth.userId }, select: { id: true } } }
    });
    res.json({ notices: notices.map((n) => ({ id: n.id, title: n.title, body: n.body, level: n.level, createdAt: n.createdAt, read: n.reads.length > 0 })) });
  } catch (err) { next(err); }
});

router.post('/notices/:id/read', requireCsrf, async (req, res, next) => {
  try {
    await prisma.platformNoticeRead.upsert({ where: { noticeId_userId: { noticeId: req.params.id, userId: req.auth.userId } }, update: {}, create: { noticeId: req.params.id, userId: req.auth.userId } }).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Webhook público de Winsap: /api/billing/webhook/winsap ----
const webhook = express.Router();
webhook.post('/winsap', async (req, res) => {
  try {
    const signed = billing.verifySignature(req.rawBody, req.get('x-winsap-signature'));
    if (req.get('x-winsap-signature') && !signed) return res.status(401).json({ error: 'Firma inválida' });
    const ref = billing.pickReference(req.body);
    const payment = await billing.findPending(ref);
    if (!payment) { console.warn('[billing] webhook sin pago asociado', JSON.stringify(req.body).slice(0, 300)); return res.status(202).json({ ok: true }); }
    if (payment.status === 'paid') return res.json({ ok: true });
    const event = String(req.body?.event || '');
    const looksPaid = !event || event === 'payment.paid' || ref.status === 'paid';
    if (!looksPaid) return res.json({ ok: true });
    if (signed) {
      await billing.activatePayment(payment, { winsapPaymentId: ref.paymentId != null ? String(ref.paymentId) : null, paymentMethod: ref.method, raw: req.body });
    } else {
      // Sin firma válida no se acredita a ciegas: se confirma contra la API de Winsap.
      await billing.syncPendingPayments(payment.organizationId);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[billing] webhook error', err);
    res.status(500).json({ error: 'Error procesando el webhook' });
  }
});

// Pago de una recarga de SMS (mismo procesador Winsap): acredita el saldo apenas se confirma el pago.
webhook.post('/winsap-sms', async (req, res) => {
  try {
    const sms = require('../lib/sms');
    const signed = billing.verifySignature(req.rawBody, req.get('x-winsap-signature'));
    if (req.get('x-winsap-signature') && !signed) return res.status(401).json({ error: 'Firma inválida' });
    const ref = billing.pickReference(req.body);
    const purchase = await sms.findPurchase(ref);
    if (!purchase) { console.warn('[sms] webhook de pago sin recarga asociada', JSON.stringify(req.body).slice(0, 300)); return res.status(202).json({ ok: true }); }
    if (purchase.status === 'paid') return res.json({ ok: true });
    const event = String(req.body?.event || '');
    const looksPaid = !event || event === 'payment.paid' || ref.status === 'paid';
    if (!looksPaid) return res.json({ ok: true });
    if (signed) {
      await sms.activatePurchase(purchase, { winsapPaymentId: ref.paymentId != null ? String(ref.paymentId) : null, paymentMethod: ref.method, raw: req.body });
    } else {
      // Sin firma válida no se acredita a ciegas: se confirma contra la API de Winsap.
      await sms.syncPendingPurchases(purchase.organizationId);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[sms] webhook de pago error', err);
    res.status(500).json({ error: 'Error procesando el webhook' });
  }
});

// Confirmaciones de entrega del proveedor de SMS. La URL lleva un token que solo conoce quien la registró.
webhook.post('/sms-delivery', async (req, res) => {
  try {
    if (!require('../lib/smsProvider').verifyWebhookToken(req.query.token)) return res.status(401).json({ error: 'Token inválido' });
    const body = (req.body && typeof req.body.data === 'object' && req.body.data) || req.body || {};
    const messageId = body.message_id || body.messageId || body.id;
    const raw = String(body.status || (req.body && req.body.event) || '').toLowerCase();
    if (!messageId) return res.status(202).json({ ok: true });
    const message = await prisma.smsMessage.findFirst({ where: { providerMessageId: String(messageId) } });
    if (!message) return res.status(202).json({ ok: true });
    if (/deliver/.test(raw) && message.status !== 'DELIVERED') {
      await prisma.smsMessage.update({ where: { id: message.id }, data: { status: 'DELIVERED', deliveredAt: body.delivered_at ? new Date(body.delivered_at) : new Date() } });
    } else if (/fail|undeliv|reject/.test(raw) && ['SENT', 'DELIVERED'].includes(message.status)) {
      await prisma.smsMessage.update({ where: { id: message.id }, data: { status: 'FAILED', errorMessage: String(body.error || body.reason || 'El operador no pudo entregar el SMS').slice(0, 300) } });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[sms] webhook de entrega error', err);
    res.status(500).json({ error: 'Error procesando el webhook' });
  }
});

module.exports = { router, webhook };
