const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

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
      aiEnabled: true,
      welcomeMessage: 'Hola, bienvenido a Acme',
      menuOptions: [
        { key: '1', label: 'Ventas', departmentId: sales.id },
        { key: '2', label: 'Soporte', departmentId: support.id }
      ]
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
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].direction).toBe('OUTBOUND');
    expect(detail.body.messages[0].sender).toBeNull();
    expect(detail.body.messages[0].content).toContain('Hola, bienvenido a Acme');
    expect(detail.body.messages[0].content).toContain('Para Ventas, escribí 1');
    expect(detail.body.messages[0].content).toContain('Para Soporte, escribí 2');
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

  test('el bot no actúa si aiEnabled está apagado', async () => {
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
});
