const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

describe('Pedidos', () => {
  test('crea un pedido con contacto nuevo y artículos, calcula el total', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const res = await agent
      .post('/api/org/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({
        newContact: { name: 'Juan Pérez', phone: '+595971222333' },
        items: [
          { name: 'Cemento CP IV - 50kg', quantity: 10, unitPrice: 48000 },
          { name: 'Flete', quantity: 1, unitPrice: 50000 }
        ]
      });

    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe('RECEIVED');
    expect(res.body.order.total).toBe(530000);
    expect(res.body.order.items).toHaveLength(2);

    const list = await agent.get('/api/org/orders');
    expect(list.body.orders.some((o) => o.id === res.body.order.id)).toBe(true);
  });

  test('cambia estado y responsable', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const logistics = await createUser(prisma, { organizationId: org.id, email: 'log@acme.test', role: 'AGENT' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const created = await agent
      .post('/api/org/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' }, items: [{ name: 'Producto', quantity: 1, unitPrice: 1000 }] });

    const updated = await agent
      .patch(`/api/org/orders/${created.body.order.id}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'DISPATCHED', assignedToId: logistics.id });

    expect(updated.status).toBe(200);
    expect(updated.body.order.status).toBe('DISPATCHED');
    expect(updated.body.order.assignedTo.id).toBe(logistics.id);
  });

  test('reemplaza los artículos y recalcula el total', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const created = await agent
      .post('/api/org/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' }, items: [{ name: 'A', quantity: 1, unitPrice: 1000 }] });

    const updated = await agent
      .patch(`/api/org/orders/${created.body.order.id}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ items: [{ name: 'B', quantity: 2, unitPrice: 500 }] });

    expect(updated.body.order.items).toHaveLength(1);
    expect(updated.body.order.items[0].name).toBe('B');
    expect(updated.body.order.total).toBe(1000);
  });
});

describe('Aislamiento multiempresa en pedidos', () => {
  test('una organización no ve ni puede tocar pedidos de otra', async () => {
    const orgA = await createOrganization(prisma, { slug: 'org-a' });
    const orgB = await createOrganization(prisma, { slug: 'org-b' });
    const ownerA = await createUser(prisma, { organizationId: orgA.id, email: 'owner@org-a.test', role: 'OWNER' });
    const ownerB = await createUser(prisma, { organizationId: orgB.id, email: 'owner@org-b.test', role: 'OWNER' });

    const { agent: agentB, csrfToken: csrfB } = await loginAgent(app, ownerB.email);
    const orderB = await agentB
      .post('/api/org/orders')
      .set('X-CSRF-Token', csrfB)
      .send({ newContact: { name: 'Cliente B' }, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });

    const { agent: agentA, csrfToken: csrfA } = await loginAgent(app, ownerA.email);

    const getRes = await agentA.get(`/api/org/orders/${orderB.body.order.id}`);
    expect(getRes.status).toBe(404);

    const patchRes = await agentA
      .patch(`/api/org/orders/${orderB.body.order.id}`)
      .set('X-CSRF-Token', csrfA)
      .send({ status: 'CANCELLED' });
    expect(patchRes.status).toBe(404);
  });
});
