const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { prisma } = require('../lib/prisma');
const { audit } = require('../lib/audit');
const { requireAuth, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { STATUSES, createOrderSchema, updateOrderSchema } = require('../validation/orders.validation');
const { HttpError } = require('../lib/errors');

const router = express.Router();

router.use(requireAuth, requireOrgContext);
router.use(requirePermission('orders'));

const ORDER_INCLUDE = {
  contact: true,
  assignedTo: { select: { id: true, name: true, email: true } },
  items: true
};

function sanitizeOrder(order) {
  const total = order.items.reduce((sum, item) => sum + Number(item.unitPrice || 0) * item.quantity, 0);
  return {
    id: order.id,
    status: order.status,
    notes: order.notes,
    conversationId: order.conversationId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    contact: order.contact,
    assignedTo: order.assignedTo,
    items: order.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice ? Number(i.unitPrice) : null })),
    total
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { status, contactId, assignedToId, q } = req.query;
    const where = { organizationId: req.auth.organizationId };
    const andClauses = [];

    if (status && STATUSES.includes(status)) andClauses.push({ status });
    if (contactId) andClauses.push({ contactId });
    if (assignedToId === 'me') andClauses.push({ assignedToId: req.auth.userId });
    else if (assignedToId === 'none') andClauses.push({ assignedToId: null });
    else if (typeof assignedToId === 'string' && assignedToId) andClauses.push({ assignedToId });
    if (typeof q === 'string' && q.trim()) {
      const query = q.trim();
      andClauses.push({
        OR: [
          { contact: { name: { contains: query, mode: 'insensitive' } } },
          { contact: { phone: { contains: query, mode: 'insensitive' } } },
          { notes: { contains: query, mode: 'insensitive' } }
        ]
      });
    }
    if (andClauses.length) where.AND = andClauses;

    const orders = await prisma.order.findMany({ where, include: ORDER_INCLUDE, orderBy: { updatedAt: 'desc' }, take: 100 });
    res.json({ orders: orders.map(sanitizeOrder) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const data = createOrderSchema.parse(req.body);

    let contactId = data.contactId;
    if (contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId: req.auth.organizationId } });
      if (!contact) throw new HttpError(404, 'Contacto no encontrado');
    } else {
      const contact = await prisma.contact.create({ data: { ...data.newContact, organizationId: req.auth.organizationId } });
      contactId = contact.id;
    }

    if (data.conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: data.conversationId, organizationId: req.auth.organizationId }
      });
      if (!conversation) throw new HttpError(404, 'Conversación no encontrada');
    }

    const order = await prisma.order.create({
      data: {
        organizationId: req.auth.organizationId,
        contactId,
        conversationId: data.conversationId,
        notes: data.notes,
        items: { create: data.items.map((item) => ({ name: item.name, quantity: item.quantity, unitPrice: item.unitPrice })) }
      },
      include: ORDER_INCLUDE
    });

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'order.created',
      entityType: 'Order',
      entityId: order.id
    });

    res.status(201).json({ order: sanitizeOrder(order) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, organizationId: req.auth.organizationId },
      include: ORDER_INCLUDE
    });
    if (!order) throw new HttpError(404, 'Pedido no encontrado');
    res.json({ order: sanitizeOrder(order) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireCsrf, async (req, res, next) => {
  try {
    const data = updateOrderSchema.parse(req.body);
    const existing = await prisma.order.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!existing) throw new HttpError(404, 'Pedido no encontrado');

    if (data.assignedToId) {
      const user = await prisma.user.findFirst({ where: { id: data.assignedToId, organizationId: req.auth.organizationId, active: true } });
      if (!user) throw new HttpError(404, 'Usuario no encontrado');
    }

    const { items, ...rest } = data;

    const order = await prisma.$transaction(async (tx) => {
      if (items) {
        await tx.orderItem.deleteMany({ where: { orderId: existing.id } });
      }
      return tx.order.update({
        where: { id: existing.id },
        data: {
          ...rest,
          ...(items ? { items: { create: items.map((item) => ({ name: item.name, quantity: item.quantity, unitPrice: item.unitPrice })) } } : {})
        },
        include: ORDER_INCLUDE
      });
    });

    let action = 'order.updated';
    if (data.status) action = 'order.status_changed';
    else if (typeof data.assignedToId !== 'undefined') action = 'order.assigned';

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action,
      entityType: 'Order',
      entityId: order.id,
      metadata: { status: data.status, assignedToId: data.assignedToId }
    });

    res.json({ order: sanitizeOrder(order) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
