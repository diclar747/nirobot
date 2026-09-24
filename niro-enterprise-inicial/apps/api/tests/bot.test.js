const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { menuFlow } = require('./helpers/flows');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

async function setupOrgWithMenu() {
  const org = await createOrganization(prisma, { slug: 'acme' });
  const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
  const sales = await prisma.department.create({ data: { organizationId: org.id, name: 'Ventas' } });
  const support = await prisma.department.create({ data: { organizationId: org.id, name: 'Soporte' } });
  await prisma.organizationSettings.update({
    where: { organizationId: org.id },
    data: {
      botFlow: menuFlow({
        welcome: 'Hola, bienvenido a Acme',
        options: [
          { key: '1', label: 'Ventas', departmentId: sales.id, message: 'Te derivamos a Ventas. En un momento te atienden.' },
          { key: '2', label: 'Soporte', departmentId: support.id, message: 'Te derivamos a Soporte. En un momento te atienden.' }
        ]
      })
    }
  });
  return { org, owner, sales, support };
}

describe('Bot de bienvenida y menú', () => {
  test('al crear una conversación sin departamento, el bot manda la bienvenida con el menú', async () => {
    const { owner } = await setupOrgWithMenu();
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const res = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });

    expect(res.status).toBe(201);

    const detail = await agent.get(`/api/org/conversations/${res.body.conversation.id}`);
    expect(detail.body.messages.every((m) => m.direction === 'OUTBOUND' && m.sender === null)).toBe(true);
    const text = detail.body.messages.map((m) => m.content).join('\n');
    expect(text).toContain('Hola, bienvenido a Acme');
    expect(text).toContain('1. Ventas');
    expect(text).toContain('2. Soporte');
  });

  test('no manda bienvenida si la conversación ya se crea con departamento', async () => {
    const { owner, sales } = await setupOrgWithMenu();
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const res = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' }, departmentId: sales.id });

    const detail = await agent.get(`/api/org/conversations/${res.body.conversation.id}`);
    expect(detail.body.messages).toHaveLength(0);
  });

  test('una respuesta entrante que matchea una clave del menú deriva al departamento y confirma', async () => {
    const { owner, support } = await setupOrgWithMenu();
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const conv = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;

    const reply = await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: '2', type: 'inbound' });
    expect(reply.status).toBe(201);

    const updated = await agent.get(`/api/org/conversations/${id}`);
    expect(updated.body.conversation.department.id).toBe(support.id);

    const contents = updated.body.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes('Te derivamos a Soporte'))).toBe(true);
  });

  test('una respuesta entrante que no matchea ninguna clave no deriva ni rompe nada', async () => {
    const { owner } = await setupOrgWithMenu();
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const conv = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;

    const reply = await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'hola, tengo una consulta', type: 'inbound' });
    expect(reply.status).toBe(201);

    const updated = await agent.get(`/api/org/conversations/${id}`);
    expect(updated.body.conversation.department).toBeNull();
  });

  test('el bot no actúa si no hay un flujo publicado', async () => {
    const org = await createOrganization(prisma, { slug: 'acme2' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme2.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const res = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });

    const detail = await agent.get(`/api/org/conversations/${res.body.conversation.id}`);
    expect(detail.body.messages).toHaveLength(0);
  });

  test('derivar por menú avisa al agente y, al aceptar, el cliente recibe su saludo', async () => {
    const { org, owner, sales } = await setupOrgWithMenu();
    const claudio = await createUser(prisma, { organizationId: org.id, email: 'claudio@acme.test', role: 'AGENT' });
    await prisma.user.update({ where: { id: claudio.id }, data: { name: 'Claudio Pérez' } });
    await prisma.organizationSettings.update({
      where: { organizationId: org.id },
      data: { botFlow: menuFlow({ options: [{ key: '1', label: 'Ventas', departmentId: sales.id, userId: claudio.id, message: 'Te paso con Ventas.' }] }) }
    });
    const admin = await loginAgent(app, owner.email);
    const conv = await admin.agent.post('/api/org/conversations').set('X-CSRF-Token', admin.csrfToken).send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;
    await admin.agent.post(`/api/org/conversations/${id}/messages`).set('X-CSRF-Token', admin.csrfToken).send({ content: '1', type: 'inbound' });

    const derived = await admin.agent.get(`/api/org/conversations/${id}`);
    expect(derived.body.conversation.assignedTo.id).toBe(claudio.id);
    const texts = derived.body.messages.map((m) => m.content);
    expect(texts).toContain('Te paso con Ventas.');
    expect(texts.some((t) => t.startsWith('🔄 [TRANSFERENCIA]') && t.includes('Claudio'))).toBe(true);

    const agent = await loginAgent(app, claudio.email);
    const accepted = await agent.agent.post(`/api/org/conversations/${id}/transfer-response`).set('X-CSRF-Token', agent.csrfToken).send({ action: 'accept' });
    expect(accepted.status).toBe(200);
    const after = await admin.agent.get(`/api/org/conversations/${id}`);
    const welcome = after.body.messages.find((m) => m.direction === 'OUTBOUND' && m.sender && m.sender.id === claudio.id);
    expect(welcome.content).toContain('Soy Claudio');
    expect(welcome.content).toContain('Ventas');
  });
});
