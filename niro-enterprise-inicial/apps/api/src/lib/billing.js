const crypto = require('crypto');
const { prisma } = require('./prisma');
const { HttpError } = require('./errors');

const TRIAL_HOURS = 24;
const PLAN_DAYS = 30;
const PLAN_PRICE_GS = Number(process.env.PLAN_PRICE_GS) || 49000;
const PLAN_NAME = 'Plan Niro Mensual';
const HOUR = 3600 * 1000;

function trialEndOf(org) {
  return org.trialEndsAt ? new Date(org.trialEndsAt) : new Date(new Date(org.createdAt).getTime() + TRIAL_HOURS * HOUR);
}

// Estado de acceso de una organización: trial | active | expired | exempt
function accessFor(org, now = new Date()) {
  const trialEndsAt = trialEndOf(org);
  const paidUntil = org.paidUntil ? new Date(org.paidUntil) : null;
  let state = 'expired';
  if (org.billingExempt) state = 'exempt';
  else if (paidUntil && paidUntil > now) state = 'active';
  else if (trialEndsAt > now) state = 'trial';
  const endsAt = state === 'active' ? paidUntil : state === 'trial' ? trialEndsAt : null;
  return {
    state,
    blocked: state === 'expired',
    trialEndsAt,
    paidUntil,
    endsAt,
    msLeft: endsAt ? Math.max(0, endsAt.getTime() - now.getTime()) : 0,
    priceGs: PLAN_PRICE_GS,
    planName: PLAN_NAME,
    planDays: PLAN_DAYS
  };
}

// ---------- Winsap ----------
function winsapBase() { return (process.env.WINSAP_BASE_URL || 'https://winsap.com.py').replace(/\/$/, ''); }
function winsapConfigured() { return Boolean(process.env.WINSAP_API_KEY); }

async function winsap(method, path, body) {
  if (!winsapConfigured()) throw new HttpError(503, 'El cobro en línea todavía no está configurado');
  let res;
  try {
    res = await fetch(`${winsapBase()}${path}`, {
      method,
      headers: { 'X-API-Key': process.env.WINSAP_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    throw new HttpError(502, 'No se pudo conectar con la pasarela de pago. Intentá de nuevo en unos minutos');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success === false) {
    console.error('[billing] winsap error', method, path, res.status, JSON.stringify(json || {}).slice(0, 300));
    throw new HttpError(502, (json && (json.error || json.message)) || 'La pasarela de pago rechazó la solicitud');
  }
  return json;
}

function publicOrigin() {
  return (process.env.PUBLIC_APP_URL || String(process.env.WEB_ORIGIN || '').split(',')[0] || '').trim().replace(/\/$/, '');
}

function webhookSecret() {
  return process.env.WINSAP_WEBHOOK_SECRET || crypto.createHash('sha256').update(`niro-winsap:${process.env.JWT_SECRET || ''}`).digest('hex').slice(0, 40);
}

function verifySignature(rawBody, header) {
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', webhookSecret()).update(rawBody).digest('hex')}`;
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createCheckout(organization, userEmail) {
  // Reutiliza un link pendiente reciente para no llenar de links si el cliente reintenta.
  const recent = await prisma.billingPayment.findFirst({
    where: { organizationId: organization.id, status: 'pending', paymentUrl: { not: null }, createdAt: { gt: new Date(Date.now() - 6 * HOUR) } },
    orderBy: { createdAt: 'desc' }
  });
  if (recent) return recent;

  const payment = await prisma.billingPayment.create({ data: { organizationId: organization.id, amount: PLAN_PRICE_GS, periodDays: PLAN_DAYS } });
  const origin = publicOrigin();
  try {
    const link = await winsap('POST', '/api/v1/payment-links', {
      name: PLAN_NAME,
      description: `Suscripción mensual Niro · ${organization.name}`,
      price: PLAN_PRICE_GS,
      currency: 'PYG',
      product_type: 'digital',
      success_url: `${origin}/billing?paid=1`,
      cancel_url: `${origin}/billing?cancelled=1`,
      webhook_url: `${origin}/api/billing/webhook/winsap`,
      webhook_secret: webhookSecret(),
      reference: payment.id,
      metadata: { paymentId: payment.id, organizationId: organization.id, email: userEmail || null }
    });
    const data = link.data || {};
    return prisma.billingPayment.update({
      where: { id: payment.id },
      data: { winsapLinkId: data.id != null ? String(data.id) : null, winsapLinkToken: data.token || null, paymentUrl: data.payment_url || null, raw: link }
    });
  } catch (err) {
    await prisma.billingPayment.update({ where: { id: payment.id }, data: { status: 'failed' } }).catch(() => {});
    throw err;
  }
}

// ¿La organización está bloqueada por plan vencido? (cache corto: se consulta en cada mensaje entrante)
const blockedCache = new Map();
async function isBlocked(organizationId) {
  const cached = blockedCache.get(organizationId);
  if (cached && Date.now() - cached.at < 30000) return cached.blocked;
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { createdAt: true, trialEndsAt: true, paidUntil: true, billingExempt: true } });
  const blocked = org ? accessFor(org).blocked : false;
  blockedCache.set(organizationId, { at: Date.now(), blocked });
  return blocked;
}
function clearBlockedCache(organizationId) { if (organizationId) blockedCache.delete(organizationId); else blockedCache.clear(); }

async function activatePayment(payment, extra = {}) {
  if (payment.status === 'paid') return payment;
  const org = await prisma.organization.findUnique({ where: { id: payment.organizationId } });
  if (!org) return payment;
  const base = org.paidUntil && new Date(org.paidUntil) > new Date() ? new Date(org.paidUntil) : new Date();
  const paidUntil = new Date(base.getTime() + payment.periodDays * 24 * HOUR);
  const [updated] = await prisma.$transaction([
    prisma.billingPayment.update({ where: { id: payment.id }, data: { status: 'paid', paidAt: new Date(), ...extra } }),
    prisma.organization.update({ where: { id: org.id }, data: { paidUntil } })
  ]);
  clearBlockedCache(org.id);
  try {
    require('./realtime').emitToOrg(org.id, 'billing:updated', { state: 'active', paidUntil });
  } catch { /* sin socket no pasa nada */ }
  return updated;
}

function pickReference(body) {
  const d = (body && typeof body.data === 'object' && body.data) || body || {};
  const meta = d.metadata || body?.metadata || {};
  return {
    reference: d.reference || meta.paymentId || meta.reference || body?.reference || null,
    paymentId: d.payment_id ?? d.transaction_id ?? (body?.data ? d.id : null),
    linkId: d.payment_link_id ?? d.link_id ?? null,
    token: d.token || d.link_token || null,
    status: d.status || null,
    method: d.payment_method || null
  };
}

async function findPending(ref) {
  if (ref.reference) {
    const byRef = await prisma.billingPayment.findUnique({ where: { id: String(ref.reference) } }).catch(() => null);
    if (byRef) return byRef;
  }
  if (ref.linkId != null) {
    const byLink = await prisma.billingPayment.findFirst({ where: { winsapLinkId: String(ref.linkId) } });
    if (byLink) return byLink;
  }
  if (ref.token) return prisma.billingPayment.findFirst({ where: { winsapLinkToken: String(ref.token) } });
  return null;
}

// Consulta a Winsap los pagos acreditados y activa los pendientes de la organización.
async function syncPendingPayments(organizationId) {
  const pending = await prisma.billingPayment.findMany({ where: { organizationId, status: 'pending', winsapLinkId: { not: null } } });
  if (pending.length === 0) return 0;
  const list = await winsap('GET', '/api/v1/payments?status=paid&limit=100');
  const rows = Array.isArray(list.data) ? list.data : [];
  let activated = 0;
  for (const payment of pending) {
    const hit = rows.find((row) => {
      const meta = row.metadata || {};
      return row.reference === payment.id || meta.paymentId === payment.id
        || (row.payment_link_id != null && String(row.payment_link_id) === payment.winsapLinkId)
        || (row.link_id != null && String(row.link_id) === payment.winsapLinkId)
        || (row.token && row.token === payment.winsapLinkToken);
    });
    if (hit) {
      await activatePayment(payment, { winsapPaymentId: hit.id != null ? String(hit.id) : null, paymentMethod: hit.payment_method || null, raw: hit });
      activated += 1;
    }
  }
  return activated;
}

module.exports = { isBlocked, clearBlockedCache, webhookSecret, accessFor, PLAN_PRICE_GS, PLAN_DAYS, PLAN_NAME, TRIAL_HOURS, winsap, winsapConfigured, createCheckout, activatePayment, verifySignature, pickReference, findPending, syncPendingPayments, trialEndOf, HOUR };
