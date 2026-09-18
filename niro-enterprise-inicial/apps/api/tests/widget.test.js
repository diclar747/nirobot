const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

describe('Widget público', () => {
  test('info devuelve nombre y mensaje de bienvenida de una org activa', async () => {
    await createOrganization(prisma, { slug: 'acme' });
    const res = await request(app).get('/api/public/widget/acme/info');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Org acme');
  });

  test('start crea una conversación nueva y devuelve un token', async () => {
    await createOrganization(prisma, { slug: 'acme' });
    const res = await request(app).post('/api/public/widget/acme/start').send({ name: 'Visitante Web' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.conversation.channel).toBe('web');
    expect(res.body.conversation.contact.name).toBe('Visitante Web');
  });

  test('el token permite retomar la conversación y mandar mensajes', async () => {
    await createOrganization(prisma, { slug: 'acme' });
    const start = await request(app).post('/api/public/widget/acme/start').send({ name: 'Visitante' });
    const token = start.body.token;

    const sendRes = await request(app).post('/api/public/widget/acme/messages').send({ token, content: 'Hola, necesito ayuda' });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.message.direction).toBe('INBOUND');

    const getRes = await request(app).get(`/api/public/widget/acme/conversation?token=${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.messages.some((m) => m.content === 'Hola, necesito ayuda')).toBe(true);
  });

  test('un token inventado o de otra organización nunca funciona', async () => {
    await createOrganization(prisma, { slug: 'org-a' });
    await createOrganization(prisma, { slug: 'org-b' });
    const startA = await request(app).post('/api/public/widget/org-a/start').send({ name: 'Visitante A' });
    const tokenA = startA.body.token;

    const fakeRes = await request(app).get('/api/public/widget/org-a/conversation?token=not-a-real-token-at-all');
    expect(fakeRes.status).toBe(404);

    const crossOrgRes = await request(app).get(`/api/public/widget/org-b/conversation?token=${tokenA}`);
    expect(crossOrgRes.status).toBe(404);
  });

  test('las notas internas de los agentes nunca aparecen en el widget', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });

    const start = await request(app).post('/api/public/widget/acme/start').send({ name: 'Visitante' });
    const token = start.body.token;
    const conversationId = start.body.conversation.id;

    const { agent, csrfToken } = await loginAgent(app, owner.email);
    await agent
      .post(`/api/org/conversations/${conversationId}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'nota interna secreta', type: 'note' });
    await agent
      .post(`/api/org/conversations/${conversationId}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'respuesta visible', type: 'outbound' });

    const widgetView = await request(app).get(`/api/public/widget/acme/conversation?token=${token}`);
    const contents = widgetView.body.messages.map((m) => m.content);
    expect(contents).toContain('respuesta visible');
    expect(contents).not.toContain('nota interna secreta');
  });

  test('una conversación cerrada no acepta más mensajes del visitante', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });

    const start = await request(app).post('/api/public/widget/acme/start').send({ name: 'Visitante' });
    const token = start.body.token;
    const conversationId = start.body.conversation.id;

    const { agent, csrfToken } = await loginAgent(app, owner.email);
    await agent.patch(`/api/org/conversations/${conversationId}`).set('X-CSRF-Token', csrfToken).send({ status: 'CLOSED' });

    const res = await request(app).post('/api/public/widget/acme/messages').send({ token, content: 'sigo ahí?' });
    expect(res.status).toBe(409);
  });

  test('con el bot de menú activado, el widget arranca con la bienvenida y deriva por clave', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const dept = await prisma.department.create({ data: { organizationId: org.id, name: 'Ventas' } });
    await prisma.organizationSettings.update({
      where: { organizationId: org.id },
      data: { aiEnabled: true, welcomeMessage: 'Bienvenido', menuOptions: [{ key: '1', label: 'Ventas', departmentId: dept.id }] }
    });

    const start = await request(app).post('/api/public/widget/acme/start').send({ name: 'Visitante' });
    const token = start.body.token;

    const initial = await request(app).get(`/api/public/widget/acme/conversation?token=${token}`);
    expect(initial.body.messages.some((m) => m.content.includes('Bienvenido'))).toBe(true);

    await request(app).post('/api/public/widget/acme/messages').send({ token, content: '1' });

    const after = await request(app).get(`/api/public/widget/acme/conversation?token=${token}`);
    expect(after.body.conversation.department.id).toBe(dept.id);
  });
});
