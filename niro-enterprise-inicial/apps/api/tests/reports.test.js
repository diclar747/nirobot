const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

describe('Reportes', () => {
  test('resume conversaciones, pedidos y tasa de resolución', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const c1 = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'C1' } });
    await agent.patch(`/api/org/conversations/${c1.body.conversation.id}`).set('X-CSRF-Token', csrfToken).send({ status: 'RESOLVED' });
    await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'C2' } });

    await agent
      .post('/api/org/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' }, items: [{ name: 'X', quantity: 2, unitPrice: 1000 }] });

    const res = await agent.get('/api/org/reports/summary');
    expect(res.status).toBe(200);
    expect(res.body.conversations.total).toBe(2);
    expect(res.body.conversations.byStatus.RESOLVED).toBe(1);
    expect(res.body.conversations.resolutionRate).toBe(50);
    expect(res.body.orders.total).toBe(1);
    expect(res.body.orders.revenue).toBe(2000);
  });

  test('un AGENT ve reportes por defecto, pero no si el admin se los restringe', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const agentUser = await createUser(prisma, { organizationId: org.id, email: 'agent@acme.test', role: 'AGENT' });
    const { agent } = await loginAgent(app, agentUser.email);

    expect((await agent.get('/api/org/reports/summary')).status).toBe(200);
    await prisma.user.update({ where: { id: agentUser.id }, data: { permissions: { reports: false } } });
    const res = await agent.get('/api/org/reports/summary');
    expect(res.status).toBe(403);
  });

  test('un SUPERVISOR puede ver el resumen pero no el log de auditoría', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const supervisor = await createUser(prisma, { organizationId: org.id, email: 'sup@acme.test', role: 'SUPERVISOR' });
    const { agent } = await loginAgent(app, supervisor.email);

    const summary = await agent.get('/api/org/reports/summary');
    expect(summary.status).toBe(200);

    const audit = await agent.get('/api/org/reports/audit');
    expect(audit.status).toBe(403);
  });

  test('el log de auditoría registra acciones administrativas con el nombre del actor', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    await agent.post('/api/org/departments').set('X-CSRF-Token', csrfToken).send({ name: 'Ventas' });

    const res = await agent.get('/api/org/reports/audit');
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e) => e.action === 'department.created');
    expect(entry).toBeTruthy();
    expect(entry.actorName).toBe(owner.name);
  });

  test('aislamiento: el resumen de una organización no incluye datos de otra', async () => {
    const orgA = await createOrganization(prisma, { slug: 'org-a' });
    const orgB = await createOrganization(prisma, { slug: 'org-b' });
    const ownerA = await createUser(prisma, { organizationId: orgA.id, email: 'owner@org-a.test', role: 'OWNER' });
    const ownerB = await createUser(prisma, { organizationId: orgB.id, email: 'owner@org-b.test', role: 'OWNER' });

    const { agent: agentB, csrfToken: csrfB } = await loginAgent(app, ownerB.email);
    await agentB.post('/api/org/conversations').set('X-CSRF-Token', csrfB).send({ newContact: { name: 'Cliente B' } });

    const { agent: agentA } = await loginAgent(app, ownerA.email);
    const res = await agentA.get('/api/org/reports/summary');
    expect(res.body.conversations.total).toBe(0);
  });
});
