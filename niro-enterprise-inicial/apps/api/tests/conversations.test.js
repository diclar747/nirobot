const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

async function setupOrgWithAgents() {
  const org = await createOrganization(prisma, { slug: 'acme' });
  const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
  const agentA = await createUser(prisma, { organizationId: org.id, email: 'agenta@acme.test', role: 'AGENT' });
  const agentB = await createUser(prisma, { organizationId: org.id, email: 'agentb@acme.test', role: 'AGENT' });
  const dept = await prisma.department.create({ data: { organizationId: org.id, name: 'Ventas' } });
  await prisma.departmentMember.create({ data: { departmentId: dept.id, userId: agentA.id } });
  return { org, owner, agentA, agentB, dept };
}

describe('Conversaciones', () => {
  test('crea una conversación con contacto nuevo y aparece en la lista', async () => {
    const { owner } = await setupOrgWithAgents();
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const res = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente Uno', phone: '+595981000000' }, subject: 'Consulta' });

    expect(res.status).toBe(201);
    expect(res.body.conversation.contact.name).toBe('Cliente Uno');
    expect(res.body.conversation.status).toBe('OPEN');
    expect(res.body.conversation.priority).toBe('NORMAL');

    const list = await agent.get('/api/org/conversations');
    expect(list.body.conversations.some((c) => c.id === res.body.conversation.id)).toBe(true);
  });

  test('un AGENT solo ve lo asignado a él o sin asignar en su departamento', async () => {
    const { owner, agentA, agentB, dept } = await setupOrgWithAgents();
    const { agent: ownerAgent, csrfToken: ownerCsrf } = await loginAgent(app, owner.email);

    const c1 = await ownerAgent.post('/api/org/conversations').set('X-CSRF-Token', ownerCsrf).send({ newContact: { name: 'C1' } });
    await ownerAgent
      .patch(`/api/org/conversations/${c1.body.conversation.id}`)
      .set('X-CSRF-Token', ownerCsrf)
      .send({ assignedToId: agentB.id });

    const c2 = await ownerAgent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', ownerCsrf)
      .send({ newContact: { name: 'C2' }, departmentId: dept.id });

    const c3 = await ownerAgent.post('/api/org/conversations').set('X-CSRF-Token', ownerCsrf).send({ newContact: { name: 'C3' } });

    const { agent: agentAClient } = await loginAgent(app, agentA.email);
    const listA = await agentAClient.get('/api/org/conversations');
    const idsA = listA.body.conversations.map((c) => c.id);

    expect(idsA).not.toContain(c1.body.conversation.id);
    expect(idsA).toContain(c2.body.conversation.id);
    expect(idsA).toContain(c3.body.conversation.id);
  });

  test('un AGENT no puede asignar una conversación a otro agente', async () => {
    const { owner, agentA, agentB } = await setupOrgWithAgents();
    const { agent: ownerAgent, csrfToken: ownerCsrf } = await loginAgent(app, owner.email);
    const c = await ownerAgent.post('/api/org/conversations').set('X-CSRF-Token', ownerCsrf).send({ newContact: { name: 'C' } });

    const { agent: agentAClient, csrfToken: csrfA } = await loginAgent(app, agentA.email);
    const res = await agentAClient
      .patch(`/api/org/conversations/${c.body.conversation.id}`)
      .set('X-CSRF-Token', csrfA)
      .send({ assignedToId: agentB.id });

    expect(res.status).toBe(403);
  });

  test('claim es atómico: de dos requests concurrentes solo una gana (prueba de concurrencia)', async () => {
    const { owner, agentA, agentB } = await setupOrgWithAgents();
    const { agent: ownerAgent, csrfToken: ownerCsrf } = await loginAgent(app, owner.email);
    const c = await ownerAgent.post('/api/org/conversations').set('X-CSRF-Token', ownerCsrf).send({ newContact: { name: 'C' } });

    const { agent: agentAClient, csrfToken: csrfA } = await loginAgent(app, agentA.email);
    const { agent: agentBClient, csrfToken: csrfB } = await loginAgent(app, agentB.email);

    const [resA, resB] = await Promise.all([
      agentAClient.post(`/api/org/conversations/${c.body.conversation.id}/claim`).set('X-CSRF-Token', csrfA),
      agentBClient.post(`/api/org/conversations/${c.body.conversation.id}/claim`).set('X-CSRF-Token', csrfB)
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  test('mensajes: outbound, inbound y nota interna', async () => {
    const { owner } = await setupOrgWithAgents();
    const { agent, csrfToken } = await loginAgent(app, owner.email);
    const c = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'C' } });
    const id = c.body.conversation.id;

    const m1 = await agent.post(`/api/org/conversations/${id}/messages`).set('X-CSRF-Token', csrfToken).send({ content: 'Hola' });
    expect(m1.body.message.direction).toBe('OUTBOUND');

    const m2 = await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'Cliente responde', type: 'inbound' });
    expect(m2.body.message.direction).toBe('INBOUND');

    const m3 = await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'nota interna', type: 'note' });
    expect(m3.body.message.direction).toBe('NOTE');

    const detail = await agent.get(`/api/org/conversations/${id}`);
    expect(detail.body.messages).toHaveLength(3);
  });

  test('agregar y quitar etiquetas', async () => {
    const { owner } = await setupOrgWithAgents();
    const { agent, csrfToken } = await loginAgent(app, owner.email);
    const c = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'C' } });

    const tagged = await agent
      .patch(`/api/org/conversations/${c.body.conversation.id}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ tags: ['venta', 'seguimiento'] });
    expect(tagged.body.conversation.tags).toEqual(['venta', 'seguimiento']);

    const filtered = await agent.get('/api/org/conversations?tag=venta');
    expect(filtered.body.conversations.some((conv) => conv.id === c.body.conversation.id)).toBe(true);
  });
});

describe('Aislamiento multiempresa en conversaciones', () => {
  test('una organización no ve ni puede tocar conversaciones ni contactos de otra', async () => {
    const orgA = await createOrganization(prisma, { slug: 'org-a' });
    const orgB = await createOrganization(prisma, { slug: 'org-b' });
    const ownerA = await createUser(prisma, { organizationId: orgA.id, email: 'owner@org-a.test', role: 'OWNER' });
    const ownerB = await createUser(prisma, { organizationId: orgB.id, email: 'owner@org-b.test', role: 'OWNER' });

    const { agent: agentB, csrfToken: csrfB } = await loginAgent(app, ownerB.email);
    const cB = await agentB.post('/api/org/conversations').set('X-CSRF-Token', csrfB).send({ newContact: { name: 'Cliente B' } });

    const { agent: agentA, csrfToken: csrfA } = await loginAgent(app, ownerA.email);

    const getRes = await agentA.get(`/api/org/conversations/${cB.body.conversation.id}`);
    expect(getRes.status).toBe(404);

    const patchRes = await agentA
      .patch(`/api/org/conversations/${cB.body.conversation.id}`)
      .set('X-CSRF-Token', csrfA)
      .send({ status: 'CLOSED' });
    expect(patchRes.status).toBe(404);

    const msgRes = await agentA
      .post(`/api/org/conversations/${cB.body.conversation.id}/messages`)
      .set('X-CSRF-Token', csrfA)
      .send({ content: 'hack' });
    expect(msgRes.status).toBe(404);

    const contactsRes = await agentA.get('/api/org/contacts');
    expect(contactsRes.body.contacts.every((c) => c.id !== cB.body.conversation.contact.id)).toBe(true);
  });
});
