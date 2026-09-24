const mockNiroAi = {
  isConfigured: jest.fn(() => true),
  chatCompletion: jest.fn(),
  transcribeAudio: jest.fn(),
  visionExtract: jest.fn(),
  analyzeDocument: jest.fn(),
  listAgents: jest.fn(),
  createAgent: jest.fn(),
  chatWithAgent: jest.fn(),
  NiroAiError: class NiroAiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
};

jest.mock('../src/lib/niroAi', () => mockNiroAi);

const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { aiFlow, menuFlow } = require('./helpers/flows');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
  mockNiroAi.isConfigured.mockReturnValue(true);
});

async function setupOrgWithAi({ aiEnabled = true, systemPrompt = '', menuOptions = [] } = {}) {
  const org = await createOrganization(prisma, { slug: 'acme-ai' });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner-${Date.now()}@acme-ai.test`, role: 'OWNER' });
  await prisma.organizationSettings.update({
    where: { organizationId: org.id },
    data: { aiEnabled, systemPrompt, menuOptions, botFlow: aiFlow() }
  });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { org, owner, agent, csrfToken };
}

describe('Bot de IA (chat libre) en conversaciones internas', () => {
  test('responde con IA cuando el flujo llega al bloque IA y nadie tomó el chat', async () => {
    const { agent, csrfToken } = await setupOrgWithAi();
    mockNiroAi.chatCompletion.mockResolvedValue({ content: 'Claro, te ayudo con eso.', cost: 0.001 });

    const conv = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;

    const reply = await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'hola, necesito ayuda con mi pedido', type: 'inbound' });
    expect(reply.status).toBe(201);

    expect(mockNiroAi.chatCompletion).toHaveBeenCalledTimes(1);
    const detail = await agent.get(`/api/org/conversations/${id}`);
    const contents = detail.body.messages.map((m) => m.content);
    expect(contents).toContain('Claro, te ayudo con eso.');
  });

  test('no responde si la conversación ya tiene un agente humano asignado', async () => {
    const { org, agent, csrfToken, owner } = await setupOrgWithAi();

    const conv = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;
    await prisma.conversation.update({ where: { id }, data: { assignedToId: owner.id } });
    void org;

    const reply = await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'hola de nuevo', type: 'inbound' });
    expect(reply.status).toBe(201);

    expect(mockNiroAi.chatCompletion).not.toHaveBeenCalled();
  });

  test('no responde si la conversación está resuelta', async () => {
    const { agent, csrfToken } = await setupOrgWithAi();

    const conv = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;
    await prisma.conversation.update({ where: { id }, data: { status: 'RESOLVED' } });

    await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'hola', type: 'inbound' });

    expect(mockNiroAi.chatCompletion).not.toHaveBeenCalled();
  });

  test('no responde si NIRO_AI_API_KEY no está configurada, aunque aiEnabled esté prendido', async () => {
    mockNiroAi.isConfigured.mockReturnValue(false);
    const { agent, csrfToken } = await setupOrgWithAi();

    const conv = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;

    await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'hola', type: 'inbound' });

    expect(mockNiroAi.chatCompletion).not.toHaveBeenCalled();
  });

  test('una clave de menú sigue derivando a un departamento sin llamar a la IA', async () => {
    const org = await createOrganization(prisma, { slug: 'acme-menu' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme-menu.test', role: 'OWNER' });
    const sales = await prisma.department.create({ data: { organizationId: org.id, name: 'Ventas' } });
    await prisma.organizationSettings.update({
      where: { organizationId: org.id },
      data: { botFlow: menuFlow({ options: [{ key: '1', label: 'Ventas', departmentId: sales.id, message: 'Te paso con Ventas.' }], aiFallback: true }) }
    });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const conv = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;

    const reply = await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: '1', type: 'inbound' });
    expect(reply.status).toBe(201);

    expect(mockNiroAi.chatCompletion).not.toHaveBeenCalled();
    const detail = await agent.get(`/api/org/conversations/${id}`);
    expect(detail.body.conversation.department.id).toBe(sales.id);
  });

  test('si Niro IA falla (402 sin crédito) la conversación sigue funcionando sin romperse', async () => {
    const { agent, csrfToken } = await setupOrgWithAi();
    mockNiroAi.chatCompletion.mockRejectedValue(new mockNiroAi.NiroAiError('Sin créditos', 402));

    const conv = await agent
      .post('/api/org/conversations')
      .set('X-CSRF-Token', csrfToken)
      .send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;

    const reply = await agent
      .post(`/api/org/conversations/${id}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'hola', type: 'inbound' });

    // El envío del mensaje del cliente nunca falla, aunque la IA no haya podido responder.
    expect(reply.status).toBe(201);
  });
});

describe('Bot de IA en el widget público', () => {
  test('responde con IA en el chat del sitio web cuando no hay menú que matchee', async () => {
    await createOrganization(prisma, { slug: 'acme-widget' }).then((org) =>
      prisma.organizationSettings.update({ where: { organizationId: org.id }, data: { botFlow: aiFlow() } })
    );
    mockNiroAi.chatCompletion.mockResolvedValue({ content: 'Hola, decime en qué te ayudo.', cost: 0.001 });

    const start = await request(app).post('/api/public/widget/acme-widget/start').send({ name: 'Visitante' });
    const token = start.body.token;

    const send = await request(app)
      .post('/api/public/widget/acme-widget/messages')
      .send({ token, content: 'quiero cotizar un producto' });
    expect(send.status).toBe(201);
    expect(mockNiroAi.chatCompletion).toHaveBeenCalledTimes(1);

    const conv = await request(app).get(`/api/public/widget/acme-widget/conversation?token=${token}`);
    const contents = conv.body.messages.map((m) => m.content);
    expect(contents).toContain('Hola, decime en qué te ayudo.');
  });
});
