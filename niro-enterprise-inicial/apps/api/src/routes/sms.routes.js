// SMS masivo: saldo prepago, campañas, envío rápido, historial y recargas (/api/org/sms).
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requirePermission } = require('../lib/permissions');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const sms = require('../lib/sms');
const smsText = require('../lib/smsText');
const provider = require('../lib/smsProvider');

const router = express.Router();
router.use(requireAuth, (req, _res, next) => (req.auth.organizationId ? next() : next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'))));
router.use(requirePermission('sms'), requireRole('OWNER', 'ADMIN', 'SUPERVISOR'));

const BUYERS = requireRole('OWNER', 'ADMIN');
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' });
const OK_STATUSES = ['SENT', 'DELIVERED'];

function parseDate(value) { if (!value) return null; const d = new Date(String(value)); return Number.isNaN(d.getTime()) ? null : d; }
function range(req, days = 30) {
  const to = parseDate(req.query.to) || new Date();
  const from = parseDate(req.query.from) || new Date(to.getTime() - days * 24 * 3600 * 1000);
  return { from, to };
}
function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }

const recipientSchema = z.object({ name: z.string().max(120).nullable().optional(), phone: z.string().min(1).max(40) });
const campaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  message: z.string().min(1).max(2000),
  stripAccents: z.boolean().default(true),
  contactIds: z.array(z.string().min(1).max(80)).max(20000).default([]),
  tagFilter: z.array(z.string().min(1).max(40)).max(20).default([]),
  recipients: z.array(recipientSchema).max(20000).default([]),
  saveToCrm: z.boolean().default(false),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  startNow: z.boolean().default(false)
});

const STATUS_GROUPS = { pending: ['DRAFT', 'SCHEDULED'], sending: ['SENDING'], paused: ['PAUSED'], completed: ['COMPLETED'], cancelled: ['CANCELLED'] };

// ---------------------------------------------------------------- panel
router.get('/overview', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const { from, to } = range(req);
    const rows = await prisma.$queryRaw`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Asuncion', 'YYYY-MM-DD') AS day, "status", COUNT(*)::int AS n
      FROM "SmsMessage" WHERE "organizationId" = ${organizationId} AND "createdAt" >= ${from} AND "createdAt" <= ${to}
      GROUP BY 1, 2 ORDER BY 1`;
    const byDay = new Map();
    const totals = { ok: 0, failed: 0, pending: 0, delivered: 0, total: 0 };
    for (const row of rows) {
      const bucket = byDay.get(row.day) || { day: row.day, ok: 0, failed: 0 };
      if (OK_STATUSES.includes(row.status)) { bucket.ok += row.n; totals.ok += row.n; }
      if (row.status === 'FAILED') { bucket.failed += row.n; totals.failed += row.n; }
      if (['PENDING', 'SENDING'].includes(row.status)) totals.pending += row.n;
      if (row.status === 'DELIVERED') totals.delivered += row.n;
      totals.total += row.n;
      byDay.set(row.day, bucket);
    }
    const [balance, campaigns, activeCampaigns, purchases, org, spent] = await Promise.all([
      sms.getBalance(organizationId),
      prisma.smsCampaign.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 5 }),
      prisma.smsCampaign.count({ where: { organizationId, status: { in: ['SENDING', 'SCHEDULED'] } } }),
      prisma.smsPurchase.aggregate({ where: { organizationId, status: 'paid' }, _sum: { credits: true, amount: true } }),
      prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
      prisma.smsTransaction.aggregate({ where: { organizationId, type: 'CONSUMPTION', createdAt: { gte: from, lte: to } }, _sum: { amount: true } })
    ]);
    res.json({
      balance, priceGs: sms.PRICE_GS(), packages: sms.PACKAGES, minPurchase: sms.MIN_PURCHASE, maxPurchase: sms.MAX_PURCHASE,
      providerReady: provider.configured(), range: { from, to }, totals,
      creditsUsed: -(spent._sum.amount || 0), purchased: { credits: purchases._sum.credits || 0, amount: purchases._sum.amount || 0 },
      activeCampaigns, daily: [...byDay.values()],
      recentCampaigns: await Promise.all(campaigns.map(async (c) => sms.sanitizeCampaign(c, await sms.getCounts(c.id)))),
      organization: org?.name || null
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- saldo y recargas
router.post('/purchases', BUYERS, requireCsrf, async (req, res, next) => {
  try {
    const credits = sms.validateCredits(req.body?.credits);
    const org = await prisma.organization.findUnique({ where: { id: req.auth.organizationId } });
    const user = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { id: true, email: true } });
    const purchase = await sms.createPurchase(org, user, credits);
    res.status(201).json({ purchase: sanitizePurchase(purchase) });
  } catch (err) { next(err); }
});

function sanitizePurchase(p) {
  return { id: p.id, credits: p.credits, unitPrice: p.unitPrice, amount: p.amount, status: p.status, source: p.source, paymentUrl: p.status === 'pending' ? p.paymentUrl : null, paymentMethod: p.paymentMethod, note: p.note, paidAt: p.paidAt, createdAt: p.createdAt };
}

// "Ya pagué": consulta a Winsap y acredita lo pendiente.
router.post('/purchases/verify', BUYERS, requireCsrf, async (req, res, next) => {
  try {
    const credited = await sms.syncPendingPurchases(req.auth.organizationId);
    res.json({ credited, balance: await sms.getBalance(req.auth.organizationId) });
  } catch (err) { next(err); }
});

router.get('/purchases', async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const where = { organizationId: req.auth.organizationId };
    const [rows, total] = await Promise.all([prisma.smsPurchase.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }), prisma.smsPurchase.count({ where })]);
    res.json({ purchases: rows.map(sanitizePurchase), total });
  } catch (err) { next(err); }
});

router.get('/transactions', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { from, to } = range(req, 365);
    const where = { organizationId: req.auth.organizationId, createdAt: { gte: from, lte: to }, ...(req.query.type ? { type: String(req.query.type) } : {}) };
    const [rows, total] = await Promise.all([prisma.smsTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }), prisma.smsTransaction.count({ where })]);
    res.json({ transactions: rows.map((t) => ({ id: t.id, type: t.type, amount: t.amount, balanceAfter: t.balanceAfter, note: t.note, createdAt: t.createdAt })), total });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- destinatarios
// Lee una lista pegada o subida (TXT/CSV) y dice qué números sirven, cuáles no y cuáles están repetidos.
router.post('/parse-list', requireCsrf, (req, res, next) => {
  try {
    const rows = smsText.parseRecipientList(String(req.body?.text || ''), { max: sms.MAX_RECIPIENTS });
    const valid = rows.filter((r) => r.valid);
    res.json({ rows: rows.slice(0, 500), truncated: rows.length > 500, summary: { total: rows.length, valid: valid.length, invalid: rows.filter((r) => !r.valid && r.reason !== 'Número repetido').length, duplicates: rows.filter((r) => r.reason === 'Número repetido').length }, recipients: valid.map((r) => ({ name: r.name, phone: r.phone })) });
  } catch (err) { next(err); }
});

// Contactos del CRM con teléfono, para elegirlos como destinatarios.
router.get('/audience', async (req, res, next) => {
  try {
    const contacts = await prisma.contact.findMany({ where: { organizationId: req.auth.organizationId, phone: { not: null } }, select: { id: true, name: true, phone: true, tags: true }, orderBy: { createdAt: 'desc' }, take: 5000 });
    res.json({ contacts: contacts.map((c) => ({ id: c.id, name: c.name, phone: c.phone, sms: smsText.normalizePyPhone(c.phone), tags: c.tags })) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- campañas
async function loadCampaign(req) {
  const campaign = await prisma.smsCampaign.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
  if (!campaign) throw new HttpError(404, 'Campaña de SMS no encontrada');
  return campaign;
}
async function present(campaign) { return sms.sanitizeCampaign(campaign, await sms.getCounts(campaign.id)); }

async function createAndMaybeStart(req, source) {
  const data = campaignSchema.parse(req.body);
  const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  if (scheduledAt && scheduledAt.getTime() <= Date.now() + 30000) throw new HttpError(400, 'La fecha de programación debe estar en el futuro');
  const created = await sms.createCampaign(req.auth.organizationId, req.auth.userId, { ...data, source, scheduledAt });
  await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'sms.campaign.created', entityType: 'SmsCampaign', entityId: created.campaign.id, metadata: { recipients: created.recipients, source } });
  let campaign = created.campaign;
  if (data.startNow && !scheduledAt) {
    try { campaign = await sms.startCampaign(req.auth.organizationId, campaign.id); }
    catch (err) {
      // La campaña queda guardada como borrador: la persona compra saldo y la inicia sin volver a cargarla.
      if (err.code === 'SMS_INSUFFICIENT_BALANCE') throw Object.assign(err, { data: { ...(err.data || {}), campaignId: campaign.id } });
      throw err;
    }
  }
  return { campaign, recipients: created.recipients, invalid: created.invalid };
}

router.post('/campaigns', requireCsrf, async (req, res, next) => {
  try {
    const { campaign, recipients, invalid } = await createAndMaybeStart(req, 'CAMPAIGN');
    res.status(201).json({ campaign: await present(campaign), recipients, invalid: invalid.length });
  } catch (err) { next(err); }
});

// Envío rápido: uno o varios números y un mensaje, sin armar una campaña.
router.post('/send', requireCsrf, async (req, res, next) => {
  try {
    const body = { ...req.body, name: req.body?.name || `Envío rápido ${new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion', dateStyle: 'short', timeStyle: 'short' })}`, startNow: true };
    req.body = body;
    const { campaign, recipients } = await createAndMaybeStart(req, 'QUICK');
    res.status(201).json({ campaign: await present(campaign), recipients });
  } catch (err) { next(err); }
});

router.get('/campaigns', async (req, res, next) => {
  try {
    const { from, to } = { from: parseDate(req.query.from), to: parseDate(req.query.to) };
    const where = { organizationId: req.auth.organizationId };
    if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    const group = STATUS_GROUPS[String(req.query.status || '')];
    if (group) where.status = { in: group };
    if (req.query.source) where.source = String(req.query.source);
    const q = String(req.query.q || '').trim();
    if (q) where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { message: { contains: q, mode: 'insensitive' } }];
    const list = await prisma.smsCampaign.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
    res.json({ campaigns: await Promise.all(list.map((c) => present(c))) });
  } catch (err) { next(err); }
});

router.get('/campaigns/:id', async (req, res, next) => {
  try {
    const campaign = await loadCampaign(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const status = req.query.status ? String(req.query.status) : null;
    const where = { campaignId: campaign.id, ...(status ? { status } : {}) };
    const [messages, total] = await Promise.all([prisma.smsMessage.findMany({ where, orderBy: { createdAt: 'asc' }, take: limit, skip: offset }), prisma.smsMessage.count({ where })]);
    res.json({ campaign: await present(campaign), messages: messages.map(sanitizeMessage), total });
  } catch (err) { next(err); }
});

// Datos para editar o duplicar: mensaje y lista de destinatarios (nombre y número).
router.get('/campaigns/:id/config', async (req, res, next) => {
  try {
    const campaign = await loadCampaign(req);
    const rows = await prisma.smsMessage.findMany({ where: { campaignId: campaign.id }, select: { name: true, phone: true, status: true, contactId: true }, orderBy: { createdAt: 'asc' } });
    res.json({ campaign: await present(campaign), recipients: rows.map((r) => ({ name: r.name, phone: r.phone, status: r.status, contactId: r.contactId })) });
  } catch (err) { next(err); }
});

// Editar: solo antes de que salga (borrador o programada). Reemplaza el mensaje y los destinatarios.
router.patch('/campaigns/:id', requireCsrf, async (req, res, next) => {
  try {
    const campaign = await loadCampaign(req);
    // Detenida: solo el texto de lo que falta enviar (lo ya enviado no cambia).
    if (campaign.status === 'PAUSED') {
      const body = z.object({ name: z.string().trim().min(2).max(120), message: z.string().min(1).max(2000), stripAccents: z.boolean().default(true) }).parse(req.body);
      const updated = await sms.updatePausedCampaign(req.auth.organizationId, campaign.id, body);
      await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'sms.campaign.message_updated', entityType: 'SmsCampaign', entityId: campaign.id });
      return res.json({ campaign: await present(updated) });
    }
    if (!['DRAFT', 'SCHEDULED'].includes(campaign.status)) throw new HttpError(409, 'Solo se puede editar una campaña que todavía no salió, o detenida (solo el texto). Para repetirla, duplicala.');
    const data = campaignSchema.parse(req.body);
    const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
    if (scheduledAt && scheduledAt.getTime() <= Date.now() + 30000) throw new HttpError(400, 'La fecha de programación debe estar en el futuro');
    const created = await sms.createCampaign(req.auth.organizationId, req.auth.userId, { ...data, source: campaign.source, scheduledAt });
    // Se reemplaza por la versión nueva conservando el mismo id visible para la persona: se borra la anterior.
    await prisma.smsCampaign.delete({ where: { id: campaign.id } });
    let next2 = created.campaign;
    if (data.startNow && !scheduledAt) next2 = await sms.startCampaign(req.auth.organizationId, next2.id);
    await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'sms.campaign.updated', entityType: 'SmsCampaign', entityId: next2.id, metadata: { replaced: campaign.id } });
    res.json({ campaign: await present(next2), recipients: created.recipients });
  } catch (err) { next(err); }
});

for (const action of ['start', 'resume']) {
  router.post(`/campaigns/:id/${action}`, requireCsrf, async (req, res, next) => {
    try {
      await loadCampaign(req);
      const campaign = await sms.startCampaign(req.auth.organizationId, req.params.id);
      await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: `sms.campaign.${action}`, entityType: 'SmsCampaign', entityId: campaign.id });
      res.json({ campaign: await present(campaign) });
    } catch (err) { next(err); }
  });
}
router.post('/campaigns/:id/retry-failed', requireCsrf, async (req, res, next) => {
  try {
    await loadCampaign(req);
    const campaign = await sms.retryFailed(req.auth.organizationId, req.params.id);
    await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'sms.campaign.retry_failed', entityType: 'SmsCampaign', entityId: campaign.id });
    res.json({ campaign: await present(campaign) });
  } catch (err) { next(err); }
});
router.post('/campaigns/:id/pause', requireCsrf, async (req, res, next) => {
  try { await loadCampaign(req); res.json({ campaign: await present(await sms.pauseCampaign(req.auth.organizationId, req.params.id)) }); } catch (err) { next(err); }
});
router.post('/campaigns/:id/cancel', requireCsrf, async (req, res, next) => {
  try { await loadCampaign(req); res.json({ campaign: await present(await sms.cancelCampaign(req.auth.organizationId, req.params.id)) }); } catch (err) { next(err); }
});

async function deleteCampaigns(req, ids) {
  const found = await prisma.smsCampaign.findMany({ where: { organizationId: req.auth.organizationId, id: { in: ids } }, select: { id: true, name: true, status: true } });
  const deleted = [];
  const skipped = [];
  for (const campaign of found) {
    if (campaign.status === 'SENDING') { skipped.push({ id: campaign.id, name: campaign.name, reason: 'Está enviando: pausala o cancelala antes de eliminarla' }); continue; }
    await prisma.smsCampaign.delete({ where: { id: campaign.id } });
    deleted.push(campaign.id);
    await audit(prisma, { organizationId: req.auth.organizationId, actorUserId: req.auth.userId, action: 'sms.campaign.deleted', entityType: 'SmsCampaign', entityId: campaign.id, metadata: { name: campaign.name } });
  }
  return { deleted, skipped };
}
router.post('/campaigns/bulk-delete', requireCsrf, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 500) : [];
    if (!ids.length) throw new HttpError(400, 'Elegí al menos una campaña');
    res.json(await deleteCampaigns(req, ids));
  } catch (err) { next(err); }
});
router.delete('/campaigns/:id', requireCsrf, async (req, res, next) => {
  try {
    const result = await deleteCampaigns(req, [req.params.id]);
    if (result.skipped.length) throw new HttpError(409, result.skipped[0].reason);
    if (!result.deleted.length) throw new HttpError(404, 'Campaña de SMS no encontrada');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- historial
function sanitizeMessage(m) {
  return { id: m.id, campaignId: m.campaignId, name: m.name, phone: m.phone, body: m.body, encoding: m.encoding, status: m.status, error: m.errorMessage, credits: m.credits, sentAt: m.sentAt, deliveredAt: m.deliveredAt, createdAt: m.createdAt };
}

router.get('/messages', async (req, res, next) => {
  try {
    const { from, to } = range(req, 30);
    const where = { organizationId: req.auth.organizationId, createdAt: { gte: from, lte: to } };
    const status = String(req.query.status || '');
    if (status === 'ok') where.status = { in: OK_STATUSES };
    else if (status === 'pending') where.status = { in: ['PENDING', 'SENDING'] };
    else if (status) where.status = status.toUpperCase();
    if (req.query.campaignId) where.campaignId = String(req.query.campaignId);
    const q = String(req.query.q || '').trim();
    if (q) {
      // El número se guarda como 595…: se busca también en formato local (0985…) y por partes.
      const digits = q.replace(/\D/g, '');
      const phones = [...new Set([smsText.normalizePyPhone(q), digits.replace(/^0+/, ''), digits].filter((v) => v && v.length >= 3))];
      where.OR = [...phones.map((phone) => ({ phone: { contains: phone } })), { name: { contains: q, mode: 'insensitive' } }, { body: { contains: q, mode: 'insensitive' } }];
    }
    if (req.query.format === 'csv') {
      const rows = await prisma.smsMessage.findMany({ where, include: { campaign: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 50000 });
      const lines = [['Fecha', 'Número', 'Nombre', 'Estado', 'Campaña', 'Mensaje', 'Créditos', 'Error'].map(csvCell).join(',')];
      for (const r of rows) lines.push([r.createdAt.toISOString(), r.phone, r.name || '', r.status, r.campaign?.name || '', r.body, r.status === 'FAILED' || r.status === 'CANCELLED' || r.status === 'PENDING' ? 0 : r.credits, r.errorMessage || ''].map(csvCell).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="sms.csv"');
      return res.send('﻿' + lines.join('\n'));
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const [rows, total] = await Promise.all([
      prisma.smsMessage.findMany({ where, include: { campaign: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      prisma.smsMessage.count({ where })
    ]);
    res.json({ messages: rows.map((r) => ({ ...sanitizeMessage(r), campaignName: r.campaign?.name || null })), total });
  } catch (err) { next(err); }
});

module.exports = router;
