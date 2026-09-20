const express = require('express');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const billing = require('../lib/billing');

// ---- Cliente (organización): /api/org/billing ----
const router = express.Router();
router.use(requireAuth);
router.use((req, _res, next) => (req.auth.organizationId ? next() : next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'))));

function sanitizePayment(p) {
  return { id: p.id, amount: p.amount, currency: p.currency, status: p.status, paymentUrl: p.paymentUrl, paymentMethod: p.paymentMethod, paidAt: p.paidAt, createdAt: p.createdAt };
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
    const payments = await prisma.billingPayment.findMany({ where: { organizationId: org.id, status: { in: ['paid', 'pending'] } }, orderBy: { createdAt: 'desc' }, take: 12 });
    res.json({ access: { ...access, msLeft: access.msLeft }, payments: payments.map(sanitizePayment), online: billing.winsapConfigured() });
  } catch (err) { next(err); }
});

router.post('/checkout', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const org = await loadOrg(req);
    const user = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { email: true } });
    const payment = await billing.createCheckout(org, user?.email);
    if (!payment.paymentUrl) throw new HttpError(502, 'No se pudo generar el link de pago');
    res.json({ payment: sanitizePayment(payment) });
  } catch (err) { next(err); }
});

// El cliente vuelve del pago (o toca "Ya pagué"): consultamos a Winsap y activamos.
router.post('/verify', requireCsrf, async (req, res, next) => {
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

module.exports = { router, webhook };
