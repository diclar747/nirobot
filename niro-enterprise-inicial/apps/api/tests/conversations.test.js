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
  const agentA = await createUser(prisma, { organizationId: org.id, email: 'agenta@acme.test', role: 'AGENT', autoChat: true });
  const agentB = await createUser(prisma, { organizationId: org.id, email: 'agentb@acme.test', role: 'AGENT', autoChat: true });
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

describe('Nuevo chat iniciado por un agente', () => {
  test('un contacto con teléfono abre un chat de WhatsApp a nombre de quien lo inicia, sin bienvenida del bot', async () => {
    const org = await createOrganization(prisma, { slug: `nc-${Date.now()}` });
    await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
    await prisma.organizationSettings.update({ where: { organizationId: org.id }, data: { aiEnabled: true, welcomeMessage: 'Hola, bienvenido' } });
    const owner = await createUser(prisma, { organizationId: org.id, email: `nc${Date.now()}@t.test`, role: 'OWNER' });
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana', phone: '595981000001' } });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const created = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ contactId: contact.id });
    expect(created.status).toBe(201);
    expect(created.body.conversation.channel).toBe('whatsapp');
    expect(created.body.conversation.assignedTo.id).toBe(owner.id);
    expect(await prisma.message.count({ where: { conversationId: created.body.conversation.id } })).toBe(0); // no se le manda "bienvenida" al cliente

    // pedir otro chat con el mismo contacto abre el existente, no lo duplica
    const again = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ contactId: contact.id });
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    expect(again.body.conversation.id).toBe(created.body.conversation.id);
    expect(await prisma.conversation.count({ where: { contactId: contact.id } })).toBe(1);
  });

  test('un contacto nuevo sin teléfono queda como chat manual', async () => {
    const org = await createOrganization(prisma, { slug: `nc2-${Date.now()}` });
    const owner = await createUser(prisma, { organizationId: org.id, email: `nc2${Date.now()}@t.test`, role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);
    const res = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'Sin teléfono' } });
    expect(res.status).toBe(201);
    expect(res.body.conversation.channel).toBe('manual');
  });
});

describe('Mensajes no leídos (como WhatsApp Web)', () => {
  async function setup() {
    const org = await createOrganization(prisma, { slug: `ur-${Date.now()}` });
    await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
    const owner = await createUser(prisma, { organizationId: org.id, email: `ur${Date.now()}@t.test`, role: 'OWNER' });
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana', phone: '595981000009' } });
    const conv = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp' } });
    return { org, owner, contact, conv, session: await loginAgent(app, owner.email) };
  }
  const inbound = (conv, content, createdAt = new Date()) => prisma.message.create({ data: { conversationId: conv.id, direction: 'INBOUND', content, createdAt } });

  test('cuenta los entrantes nuevos, muestra el último mensaje y se limpia al abrir el chat', async () => {
    const { conv, session } = await setup();
    await inbound(conv, 'Hola'); await inbound(conv, '¿Tienen stock?');
    await prisma.message.create({ data: { conversationId: conv.id, direction: 'OUTBOUND', content: 'respuesta mía', createdAt: new Date(Date.now() - 5000) } });

    let list = await session.agent.get('/api/org/conversations');
    expect(list.body.conversations[0].unreadCount).toBe(2);
    expect(list.body.conversations[0].lastMessage).toMatchObject({ content: '¿Tienen stock?', direction: 'INBOUND' });
    expect((await session.agent.get('/api/org/conversations/unread-summary')).body).toEqual({ conversations: 1, messages: 2 });

    const read = await session.agent.post(`/api/org/conversations/${conv.id}/read`).set('X-CSRF-Token', session.csrfToken);
    expect(read.status).toBe(200);
    list = await session.agent.get('/api/org/conversations');
    expect(list.body.conversations[0].unreadCount).toBe(0);
    expect((await session.agent.get('/api/org/conversations/unread-summary')).body.conversations).toBe(0);

    await new Promise((r) => setTimeout(r, 20));
    await inbound(conv, 'Sigo esperando');
    expect((await session.agent.get('/api/org/conversations')).body.conversations[0].unreadCount).toBe(1);
  });

  test('cada usuario tiene su propio conteo y un usuario nuevo no hereda el historial', async () => {
    const { org, owner, conv, session } = await setup();
    await prisma.user.update({ where: { id: owner.id }, data: { createdAt: new Date(Date.now() - 2 * 3600 * 1000) } }); // usuario antiguo
    await inbound(conv, 'mensaje viejo', new Date(Date.now() - 3600 * 1000));
    const late = await createUser(prisma, { organizationId: org.id, email: `late${Date.now()}@t.test`, role: 'OWNER' });
    const lateSession = await loginAgent(app, late.email);
    await inbound(conv, 'mensaje nuevo');

    expect((await session.agent.get('/api/org/conversations')).body.conversations[0].unreadCount).toBe(2);   // el primero ve ambos
    expect((await lateSession.agent.get('/api/org/conversations')).body.conversations[0].unreadCount).toBe(1); // el nuevo solo lo posterior a su alta
    await session.agent.post(`/api/org/conversations/${conv.id}/read`).set('X-CSRF-Token', session.csrfToken);
    expect((await lateSession.agent.get('/api/org/conversations')).body.conversations[0].unreadCount).toBe(1); // leer yo no lo marca leído para otro
  });

  test('no se puede marcar leída una conversación de otra organización', async () => {
    const a = await setup();
    const other = await createOrganization(prisma, { slug: `ur2-${Date.now()}` });
    await prisma.organization.update({ where: { id: other.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
    const u = await createUser(prisma, { organizationId: other.id, email: `x${Date.now()}@t.test`, role: 'OWNER' });
    const s = await loginAgent(app, u.email);
    expect((await s.agent.post(`/api/org/conversations/${a.conv.id}/read`).set('X-CSRF-Token', s.csrfToken)).status).toBe(404);
  });
});
