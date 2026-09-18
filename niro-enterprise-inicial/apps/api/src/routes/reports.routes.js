const express = require('express');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireRole } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

router.use(requireAuth, requireOrgContext, requireRole('OWNER', 'ADMIN', 'SUPERVISOR'));

router.get('/summary', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

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
      users
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
      prisma.user.findMany({ where: { organizationId }, select: { id: true, name: true } })
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

    res.json({
      period: { days, since: since.toISOString() },
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

router.get('/audit', requireRole('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));

    const [entries, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.auditLog.count({ where: { organizationId } })
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
        entityType: e.entityType,
        entityId: e.entityId,
        actorName: e.actorUserId ? actorName.get(e.actorUserId) || 'Usuario eliminado' : 'Sistema',
        createdAt: e.createdAt
      })),
      total,
      page,
      pageSize
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
