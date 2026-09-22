// Gestión: cómo terminó cada conversación (venta, cotización…), por agente, con filtros y estadísticas.
// Propietario, administrador y supervisor ven a todos los agentes; un agente solo ve lo suyo.
const express = require('express');
const { z } = require('zod');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const outcomes = require('../lib/outcomes');
const { csvCell } = require('../lib/csv');

const router = express.Router();

router.use(requireAuth, requireOrgContext);
// Leer las categorías lo necesita cualquier agente para cerrar un chat; el permiso "management" protege el análisis.
const needsManagement = requirePermission('management');

const MANAGERS = ['OWNER', 'ADMIN', 'SUPERVISOR'];
const isManager = (req) => MANAGERS.includes(req.auth.role);

// ---- Categorías ----
const categorySchema = z.object({
  name: z.string().trim().min(2).max(60),
  kind: z.enum(outcomes.KINDS).default('OTHER'),
  requiresAmount: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional()
});

function sanitizeCategory(category, used = 0) {
  return { id: category.id, name: category.name, kind: category.kind, requiresAmount: category.requiresAmount, color: category.color, active: category.active, sortOrder: category.sortOrder, used };
}

router.get('/categories', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    await outcomes.ensureDefaultCategories(organizationId);
    const showAll = req.query.all === '1' && isManager(req);
    const [categories, usage] = await Promise.all([
      prisma.outcomeCategory.findMany({ where: { organizationId, ...(showAll ? {} : { active: true }) }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      prisma.conversationOutcome.groupBy({ by: ['categoryId'], where: { organizationId }, _count: true })
    ]);
    const used = new Map(usage.map((row) => [row.categoryId, row._count]));
    res.json({ categories: categories.map((category) => sanitizeCategory(category, used.get(category.id) || 0)) });
  } catch (err) { next(err); }
});

router.post('/categories', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const data = categorySchema.parse(req.body);
    const organizationId = req.auth.organizationId;
    await outcomes.ensureDefaultCategories(organizationId);
    const last = await prisma.outcomeCategory.findFirst({ where: { organizationId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    let category;
    try {
      category = await prisma.outcomeCategory.create({
        data: { organizationId, name: data.name, kind: data.kind, requiresAmount: data.kind === 'WON' ? true : Boolean(data.requiresAmount), color: data.color || '#64748b', active: data.active !== false, sortOrder: data.sortOrder ?? (last ? last.sortOrder + 1 : 0) }
      });
    } catch (err) {
      if (err.code === 'P2002') throw new HttpError(409, 'Ya existe una categoría con ese nombre');
      throw err;
    }
    await audit(prisma, { organizationId, actorUserId: req.auth.userId, action: 'outcome.category.created', entityType: 'OutcomeCategory', entityId: category.id, metadata: { name: category.name, kind: category.kind } });
    res.status(201).json({ category: sanitizeCategory(category) });
  } catch (err) { next(err); }
});

router.patch('/categories/:id', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const data = categorySchema.partial().parse(req.body);
    if (!Object.keys(data).length) throw new HttpError(400, 'No hay cambios para aplicar');
    const organizationId = req.auth.organizationId;
    const existing = await prisma.outcomeCategory.findFirst({ where: { id: req.params.id, organizationId } });
    if (!existing) throw new HttpError(404, 'Categoría no encontrada');
    const kind = data.kind || existing.kind;
    const update = { ...data, ...(kind === 'WON' ? { requiresAmount: true } : {}) };
    let category;
    try {
      category = await prisma.outcomeCategory.update({ where: { id: existing.id }, data: update });
    } catch (err) {
      if (err.code === 'P2002') throw new HttpError(409, 'Ya existe una categoría con ese nombre');
      throw err;
    }
    // El historial guarda copia del nombre y del tipo: cambiarlos no reescribe gestiones pasadas.
    await audit(prisma, { organizationId, actorUserId: req.auth.userId, action: 'outcome.category.updated', entityType: 'OutcomeCategory', entityId: category.id, metadata: data });
    res.json({ category: sanitizeCategory(category) });
  } catch (err) { next(err); }
});

router.delete('/categories/:id', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const existing = await prisma.outcomeCategory.findFirst({ where: { id: req.params.id, organizationId } });
    if (!existing) throw new HttpError(404, 'Categoría no encontrada');
    const used = await prisma.conversationOutcome.count({ where: { categoryId: existing.id } });
    // Con historial se desactiva (deja de ofrecerse pero las estadísticas conservan sus datos); sin uso se borra.
    if (used > 0) {
      await prisma.outcomeCategory.update({ where: { id: existing.id }, data: { active: false } });
    } else {
      await prisma.outcomeCategory.delete({ where: { id: existing.id } });
    }
    await audit(prisma, { organizationId, actorUserId: req.auth.userId, action: 'outcome.category.deleted', entityType: 'OutcomeCategory', entityId: existing.id, metadata: { name: existing.name, deactivated: used > 0 } });
    res.json({ ok: true, deactivated: used > 0 });
  } catch (err) { next(err); }
});

// ---- Filtros comunes ----
function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function range(req) {
  const to = parseDate(req.query.to) || new Date();
  const from = parseDate(req.query.from) || new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  return { from, to };
}

function outcomeWhere(req) {
  const { from, to } = range(req);
  const where = { organizationId: req.auth.organizationId, createdAt: { gte: from, lte: to } };
  // Un agente solo ve su propia gestión, sin importar lo que pida.
  if (!isManager(req)) where.agentId = req.auth.userId;
  else if (req.query.agentId) where.agentId = String(req.query.agentId);
  if (req.query.categoryId) where.categoryId = String(req.query.categoryId);
  if (req.query.kind && outcomes.KINDS.includes(String(req.query.kind))) where.kind = String(req.query.kind);
  const q = String(req.query.q || '').trim();
  if (q) {
    where.OR = [
      { note: { contains: q, mode: 'insensitive' } },
      { categoryName: { contains: q, mode: 'insensitive' } },
      { agentName: { contains: q, mode: 'insensitive' } },
      { contact: { is: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] } } }
    ];
  }
  return where;
}

const OUTCOME_INCLUDE = { contact: { select: { id: true, name: true, phone: true } }, category: { select: { color: true } } };

router.get('/outcomes', needsManagement, async (req, res, next) => {
  try {
    const where = outcomeWhere(req);
    if (req.query.format === 'csv') {
      const rows = await prisma.conversationOutcome.findMany({ where, include: OUTCOME_INCLUDE, orderBy: { createdAt: 'desc' }, take: 10000 });
      const lines = [['Fecha', 'Agente', 'Categoría', 'Tipo', 'Monto', 'Contacto', 'Teléfono', 'Cerró la conversación', 'Nota'].map(csvCell).join(',')];
      for (const row of rows) {
        lines.push([row.createdAt.toISOString(), row.agentName, row.categoryName, outcomes.KIND_LABEL[row.kind] || row.kind, row.amount === null ? '' : Number(row.amount), row.contact?.name || '', row.contact?.phone || '', row.closedConversation ? 'Sí' : 'No', row.note || ''].map(csvCell).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="gestion.csv"');
      return res.send('﻿' + lines.join('\n'));
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const [rows, total] = await Promise.all([
      prisma.conversationOutcome.findMany({ where, include: OUTCOME_INCLUDE, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      prisma.conversationOutcome.count({ where })
    ]);
    res.json({ outcomes: rows.map(outcomes.sanitizeOutcome), total });
  } catch (err) { next(err); }
});

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' });

router.get('/summary', needsManagement, async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const { from, to } = range(req);
    const where = outcomeWhere(req);
    const rows = await prisma.conversationOutcome.findMany({
      where,
      select: { agentId: true, agentName: true, categoryId: true, categoryName: true, kind: true, amount: true, closedConversation: true, createdAt: true, category: { select: { color: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50000
    });

    const blank = () => ({ outcomes: 0, won: 0, lost: 0, quotes: 0, other: 0, revenue: 0, closed: 0 });
    const add = (bucket, row) => {
      const amount = row.amount === null ? 0 : Number(row.amount);
      bucket.outcomes += 1;
      if (row.kind === 'WON') { bucket.won += 1; bucket.revenue += amount; }
      else if (row.kind === 'LOST') bucket.lost += 1;
      else if (row.kind === 'QUOTE') bucket.quotes += 1;
      else bucket.other += 1;
      if (row.closedConversation) bucket.closed += 1;
    };
    const rate = (bucket) => (bucket.won + bucket.lost > 0 ? Math.round((bucket.won / (bucket.won + bucket.lost)) * 1000) / 10 : null);
    const ticket = (bucket) => (bucket.won > 0 ? Math.round(bucket.revenue / bucket.won) : 0);

    const totals = blank();
    const agents = new Map();
    const categories = new Map();
    const daily = new Map();
    for (const row of rows) {
      add(totals, row);
      const agentKey = row.agentId || `deleted:${row.agentName}`;
      if (!agents.has(agentKey)) agents.set(agentKey, { agentId: row.agentId, name: row.agentName, ...blank(), messages: 0, chats: 0 });
      add(agents.get(agentKey), row);
      const categoryKey = row.categoryId || `deleted:${row.categoryName}`;
      if (!categories.has(categoryKey)) categories.set(categoryKey, { categoryId: row.categoryId, name: row.categoryName, kind: row.kind, color: row.category?.color || '#64748b', count: 0, amount: 0 });
      const category = categories.get(categoryKey);
      category.count += 1;
      category.amount += row.amount === null ? 0 : Number(row.amount);
      const day = DAY_FORMAT.format(row.createdAt);
      if (!daily.has(day)) daily.set(day, { day, ...blank() });
      add(daily.get(day), row);
    }

    // Actividad de chat de cada agente en el período: mensajes enviados y conversaciones atendidas.
    const activityAgent = isManager(req) ? (req.query.agentId ? String(req.query.agentId) : null) : req.auth.userId;
    const activity = await prisma.$queryRaw`
      SELECT m."senderUserId" AS "agentId", COUNT(*)::int AS messages, COUNT(DISTINCT m."conversationId")::int AS chats
      FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE c."organizationId" = ${organizationId} AND m."direction" = 'OUTBOUND' AND m."senderUserId" IS NOT NULL
        AND m."createdAt" >= ${from} AND m."createdAt" <= ${to}
        AND (${activityAgent}::text IS NULL OR m."senderUserId" = ${activityAgent})
      GROUP BY m."senderUserId"`;
    const roster = await prisma.user.findMany({
      where: { organizationId, active: true, ...(isManager(req) ? (req.query.agentId ? { id: String(req.query.agentId) } : { role: { in: ['AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER'] } }) : { id: req.auth.userId }) },
      select: { id: true, name: true, role: true }
    });
    const names = new Map(roster.map((user) => [user.id, user.name]));
    for (const user of roster) if (!agents.has(user.id) && (user.role === 'AGENT' || activity.some((a) => a.agentId === user.id))) agents.set(user.id, { agentId: user.id, name: user.name, ...blank(), messages: 0, chats: 0 });
    for (const row of activity) {
      if (!agents.has(row.agentId)) agents.set(row.agentId, { agentId: row.agentId, name: names.get(row.agentId) || 'Agente', ...blank(), messages: 0, chats: 0 });
      Object.assign(agents.get(row.agentId), { messages: row.messages, chats: row.chats });
    }

    res.json({
      range: { from, to },
      totals: { ...totals, avgTicket: ticket(totals), winRate: rate(totals) },
      byAgent: [...agents.values()].map((a) => ({ ...a, avgTicket: ticket(a), winRate: rate(a) })).sort((a, b) => b.revenue - a.revenue || b.outcomes - a.outcomes || a.name.localeCompare(b.name)),
      byCategory: [...categories.values()].sort((a, b) => b.count - a.count),
      daily: [...daily.values()]
    });
  } catch (err) { next(err); }
});

module.exports = router;
