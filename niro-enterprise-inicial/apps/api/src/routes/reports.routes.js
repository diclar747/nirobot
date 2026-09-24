const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireRole, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');

const router = express.Router();

router.use(requireAuth, requireOrgContext, requirePermission('reports'));

router.get('/summary', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const previousSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);

    const [
      conversationsTotal,
      conversationsByStatus,
      conversationsByChannel,
      conversationsByDepartment,
      conversationsByAgent,
      conversationsForResponseTime,
      ordersTotal,
      ordersByStatus,
      ordersForRevenue,
      departments,
      users,
      dailyConversations,
      dailyMessages,
      dailyOrders,
      hourly,
      prevConversations,
      prevOrders,
      prevOrdersForRevenue,
      inboundMessages,
      prevInboundMessages
    ] = await Promise.all([
      prisma.conversation.count({ where: { organizationId, createdAt: { gte: since } } }),
      prisma.conversation.groupBy({ by: ['status'], where: { organizationId, createdAt: { gte: since } }, _count: true }),
      prisma.conversation.groupBy({ by: ['channel'], where: { organizationId, createdAt: { gte: since } }, _count: true }),
      prisma.conversation.groupBy({
        by: ['departmentId'],
        where: { organizationId, createdAt: { gte: since } },
        _count: true
      }),
      prisma.conversation.groupBy({
        by: ['assignedToId'],
        where: { organizationId, createdAt: { gte: since } },
        _count: true
      }),
      prisma.conversation.findMany({
        where: { organizationId, createdAt: { gte: since } },
        select: {
          id: true,
          createdAt: true,
          messages: {
            where: { direction: 'OUTBOUND', senderUserId: { not: null } },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { createdAt: true }
          }
        }
      }),
      prisma.order.count({ where: { organizationId, createdAt: { gte: since } } }),
      prisma.order.groupBy({ by: ['status'], where: { organizationId, createdAt: { gte: since } }, _count: true }),
      prisma.order.findMany({
        where: { organizationId, createdAt: { gte: since }, status: { not: 'CANCELLED' } },
        select: { items: { select: { quantity: true, unitPrice: true } } }
      }),
      prisma.department.findMany({ where: { organizationId }, select: { id: true, name: true } }),
      prisma.user.findMany({ where: { organizationId }, select: { id: true, name: true } }),
      // Series diarias y mapa de calor: se resuelven en la base para no traer miles de filas.
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', c."createdAt"), 'YYYY-MM-DD') AS day, count(*)::int AS total
          FROM "Conversation" c
         WHERE c."organizationId" = ${organizationId} AND c."createdAt" >= ${since}
         GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', m."createdAt"), 'YYYY-MM-DD') AS day,
               count(*) FILTER (WHERE m.direction = 'INBOUND')::int  AS inbound,
               count(*) FILTER (WHERE m.direction = 'OUTBOUND')::int AS outbound
          FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
         WHERE c."organizationId" = ${organizationId} AND m."createdAt" >= ${since} AND m.direction <> 'NOTE'
         GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', o."createdAt"), 'YYYY-MM-DD') AS day, count(*)::int AS orders,
               coalesce(sum(i.quantity * i."unitPrice"), 0)::float AS revenue
          FROM "Order" o LEFT JOIN "OrderItem" i ON i."orderId" = o.id
         WHERE o."organizationId" = ${organizationId} AND o."createdAt" >= ${since} AND o.status <> 'CANCELLED'
         GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw`
        SELECT extract(dow from m."createdAt")::int AS weekday, extract(hour from m."createdAt")::int AS hour, count(*)::int AS total
          FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
         WHERE c."organizationId" = ${organizationId} AND m."createdAt" >= ${since} AND m.direction = 'INBOUND'
         GROUP BY 1, 2`,
      // Período anterior (mismo largo) para comparar.
      prisma.conversation.count({ where: { organizationId, createdAt: { gte: previousSince, lt: since } } }),
      prisma.order.count({ where: { organizationId, createdAt: { gte: previousSince, lt: since } } }),
      prisma.order.findMany({
        where: { organizationId, createdAt: { gte: previousSince, lt: since }, status: { not: 'CANCELLED' } },
        select: { items: { select: { quantity: true, unitPrice: true } } }
      }),
      prisma.message.count({ where: { direction: 'INBOUND', createdAt: { gte: since }, conversation: { organizationId } } }),
      prisma.message.count({ where: { direction: 'INBOUND', createdAt: { gte: previousSince, lt: since }, conversation: { organizationId } } })
    ]);

    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const userName = new Map(users.map((u) => [u.id, u.name]));

    const responseSamples = conversationsForResponseTime
      .filter((c) => c.messages.length > 0)
      .map((c) => (c.messages[0].createdAt.getTime() - c.createdAt.getTime()) / 60000);
    const avgFirstResponseMinutes =
      responseSamples.length > 0 ? Math.round(responseSamples.reduce((a, b) => a + b, 0) / responseSamples.length) : null;

    const resolvedOrClosed = conversationsByStatus
      .filter((s) => s.status === 'RESOLVED' || s.status === 'CLOSED')
      .reduce((sum, s) => sum + s._count, 0);
    const resolutionRate = conversationsTotal > 0 ? Math.round((resolvedOrClosed / conversationsTotal) * 100) : 0;

    const revenue = ordersForRevenue.reduce(
      (sum, order) => sum + order.items.reduce((s, i) => s + Number(i.unitPrice || 0) * i.quantity, 0),
      0
    );

    // Una fila por día, también los días sin actividad: el gráfico no puede tener huecos.
    const dayKey = (date) => date.toISOString().slice(0, 10);
    const convByDay = new Map(dailyConversations.map((row) => [row.day, row.total]));
    const msgByDay = new Map(dailyMessages.map((row) => [row.day, row]));
    const orderByDay = new Map(dailyOrders.map((row) => [row.day, row]));
    const series = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const key = dayKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
      const messages = msgByDay.get(key);
      const orders = orderByDay.get(key);
      series.push({
        day: key,
        conversations: convByDay.get(key) || 0,
        inbound: messages ? messages.inbound : 0,
        outbound: messages ? messages.outbound : 0,
        orders: orders ? orders.orders : 0,
        revenue: orders ? Math.round(orders.revenue) : 0
      });
    }

    const prevRevenue = prevOrdersForRevenue.reduce(
      (sum, order) => sum + order.items.reduce((s, i) => s + Number(i.unitPrice || 0) * i.quantity, 0),
      0
    );
    // Variación contra el período anterior: null cuando antes no hubo nada (no existe "subió 100%" desde cero).
    const change = (current, previous) => (previous > 0 ? Math.round(((current - previous) / previous) * 100) : null);

    res.json({
      period: { days, since: since.toISOString(), previousSince: previousSince.toISOString() },
      series,
      heatmap: hourly.map((row) => ({ weekday: row.weekday, hour: row.hour, total: row.total })),
      messages: { inbound: inboundMessages },
      previous: {
        conversations: prevConversations,
        orders: prevOrders,
        revenue: prevRevenue,
        inbound: prevInboundMessages
      },
      trends: {
        conversations: change(conversationsTotal, prevConversations),
        orders: change(ordersTotal, prevOrders),
        revenue: change(revenue, prevRevenue),
        inbound: change(inboundMessages, prevInboundMessages)
      },
      conversations: {
        total: conversationsTotal,
        byStatus: Object.fromEntries(conversationsByStatus.map((s) => [s.status, s._count])),
        byChannel: conversationsByChannel.map((c) => ({ channel: c.channel, count: c._count })).sort((a, b) => b.count - a.count),
        byDepartment: conversationsByDepartment
          .map((d) => ({ departmentId: d.departmentId, name: d.departmentId ? deptName.get(d.departmentId) || '—' : 'Sin departamento', count: d._count }))
          .sort((a, b) => b.count - a.count),
        byAgent: conversationsByAgent
          .map((a) => ({ userId: a.assignedToId, name: a.assignedToId ? userName.get(a.assignedToId) || '—' : 'Sin asignar', count: a._count }))
          .sort((a, b) => b.count - a.count),
        resolutionRate,
        avgFirstResponseMinutes
      },
      orders: {
        total: ordersTotal,
        byStatus: Object.fromEntries(ordersByStatus.map((s) => [s.status, s._count])),
        revenue
      }
    });
  } catch (err) {
    next(err);
  }
});

// Categoría a partir de la acción ("status_post.created" -> "Estados"): agrupa decenas de "action" distintos
// en un puñado de categorías que sirven como filtro, sin tener que mantener una lista a mano.
const CATEGORIES = [
  { name: 'Flujos de Bot', prefixes: ['bot_flow.'] },
  { name: 'Campañas', prefixes: ['campaign.'] },
  { name: 'Estados', prefixes: ['status_post.', 'status_campaign.'] },
  { name: 'Llamadas', prefixes: ['call.'] },
  { name: 'SMS', prefixes: ['sms.'] },
  { name: 'Conversaciones', prefixes: ['conversation.'] },
  { name: 'Contactos', prefixes: ['contact.'] },
  { name: 'Pedidos', prefixes: ['order.'] },
  { name: 'Áreas', prefixes: ['department.'] },
  { name: 'Usuarios', prefixes: ['user.'] },
  { name: 'API', prefixes: ['api_key.'] },
  { name: 'Organización', prefixes: ['organization.', 'billing.'] },
  { name: 'Sesión', prefixes: ['auth.'] },
  { name: 'Superadmin', prefixes: ['superadmin.'] }
];
function categoryOf(action) {
  const hit = CATEGORIES.find((c) => c.prefixes.some((prefix) => action.startsWith(prefix)));
  return hit ? hit.name : 'Otros';
}

// Filtros disponibles para la pantalla: qué acciones y entidades existen realmente (no una lista fija que se
// desactualiza), y quién estuvo activo, para armar los desplegables.
router.get('/audit/filters', requireRole('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const [actions, entityTypes, actorRows] = await Promise.all([
      prisma.auditLog.findMany({ where: { organizationId }, distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
      prisma.auditLog.findMany({ where: { organizationId }, distinct: ['entityType'], select: { entityType: true }, orderBy: { entityType: 'asc' } }),
      // AuditLog.actorUserId es un id suelto (sin relación): se buscan los ids distintos y después los usuarios.
      prisma.auditLog.findMany({ where: { organizationId, actorUserId: { not: null } }, distinct: ['actorUserId'], select: { actorUserId: true } })
    ]);
    const actorIds = actorRows.map((row) => row.actorUserId).filter(Boolean);
    const actors = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
      : [];
    const categories = [...new Set(actions.map((a) => categoryOf(a.action)))].sort((a, b) => a.localeCompare(b, 'es'));
    res.json({
      categories,
      actions: actions.map((a) => a.action),
      entityTypes: entityTypes.map((e) => e.entityType),
      actors
    });
  } catch (err) {
    next(err);
  }
});

router.get('/audit', requireRole('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 15));
    const { q, entityType, actorUserId, category, from, to } = req.query;

    const where = { organizationId };
    if (entityType) where.entityType = String(entityType);
    if (actorUserId === 'system') where.actorUserId = null;
    else if (actorUserId) where.actorUserId = String(actorUserId);
    if (category) {
      const found = CATEGORIES.find((c) => c.name === category);
      if (found) where.OR = found.prefixes.map((prefix) => ({ action: { startsWith: prefix } }));
      else if (String(category) === 'Otros') where.NOT = CATEGORIES.flatMap((c) => c.prefixes).map((prefix) => ({ action: { startsWith: prefix } }));
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(String(from));
      if (to) where.createdAt.lte = new Date(`${to}T23:59:59.999`);
    }
    if (q) {
      const term = String(q).trim();
      where.AND = [{
        OR: [
          { action: { contains: term, mode: 'insensitive' } },
          { entityType: { contains: term, mode: 'insensitive' } },
          { entityId: { contains: term, mode: 'insensitive' } }
        ]
      }];
    }

    const [entries, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.auditLog.count({ where })
    ]);

    const actorIds = [...new Set(entries.map((e) => e.actorUserId).filter(Boolean))];
    const actors = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
      : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    res.json({
      entries: entries.map((e) => ({
        id: e.id,
        action: e.action,
        category: categoryOf(e.action),
        entityType: e.entityType,
        entityId: e.entityId,
        metadata: e.metadata,
        actorUserId: e.actorUserId,
        actorName: e.actorUserId ? actorName.get(e.actorUserId) || 'Usuario eliminado' : 'Sistema',
        createdAt: e.createdAt
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
