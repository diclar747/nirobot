class MockNiroAiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NiroAiError';
    this.status = status;
  }
}

const mockNiroAi = {
  isConfigured: jest.fn(() => true),
  chatCompletion: jest.fn(),
  transcribeAudio: jest.fn(),
  visionExtract: jest.fn(),
  analyzeDocument: jest.fn(),
  listAgents: jest.fn(),
  createAgent: jest.fn(),
  chatWithAgent: jest.fn(),
  NiroAiError: MockNiroAiError
};

jest.mock('../src/lib/niroAi', () => mockNiroAi);

const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
  mockNiroAi.isConfigured.mockReturnValue(true);
});

async function setupOrg(role = 'OWNER') {
  const org = await createOrganization(prisma, { slug: 'ai-co' });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner-${Date.now()}@ai.test`, role });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { org, owner, agent, csrfToken };
}

describe('Agentes IA — /api/org/ai', () => {
  test('GET /status refleja si hay API key configurada y si la IA está habilitada', async () => {
    const { agent } = await setupOrg();
    mockNiroAi.isConfigured.mockReturnValue(false);

    const res = await agent.get('/api/org/ai/status');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.aiEnabled).toBe(false);
  });

  test('GET /status devuelve aiEnabled true cuando la organización lo activó', async () => {
    const { org, agent } = await setupOrg();
    await prisma.organizationSettings.update({ where: { organizationId: org.id }, data: { aiEnabled: true } });

    const res = await agent.get('/api/org/ai/status');
    expect(res.body.configured).toBe(true);
    expect(res.body.aiEnabled).toBe(true);
  });

  test('POST /chat/test usa el prompt de la organización y devuelve la respuesta', async () => {
    const { agent, csrfToken } = await setupOrg('OWNER');
    mockNiroAi.chatCompletion.mockResolvedValue({ content: 'Hola, ¿en qué te ayudo?', cost: 0.001 });

    const res = await agent
      .post('/api/org/ai/chat/test')
      .set('X-CSRF-Token', csrfToken)
      .send({ message: 'hola' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Hola, ¿en qué te ayudo?');
    expect(mockNiroAi.chatCompletion).toHaveBeenCalledTimes(1);
    const [messages] = mockNiroAi.chatCompletion.mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'hola' });
  });

  test('POST /chat/test rechaza a un AGENT si el admin le quitó los agentes de IA', async () => {
    const { agent, csrfToken } = await setupOrg('AGENT');
    await prisma.user.updateMany({ where: { role: 'AGENT' }, data: { permissions: { aiAgents: false } } });
    const res = await agent.post('/api/org/ai/chat/test').set('X-CSRF-Token', csrfToken).send({ message: 'hola' });
    expect(res.status).toBe(403);
  });

  test('POST /chat/test propaga un error de saldo (402) de Niro IA', async () => {
    const { agent, csrfToken } = await setupOrg('OWNER');
    mockNiroAi.chatCompletion.mockRejectedValue(new MockNiroAiError('Sin créditos', 402));

    const res = await agent.post('/api/org/ai/chat/test').set('X-CSRF-Token', csrfToken).send({ message: 'hola' });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('Sin créditos');
  });

  test('GET /agents lista los agentes propios de la organización', async () => {
    const { org, agent } = await setupOrg('AGENT');
    await prisma.auditLog.create({ data: { organizationId: org.id, action: 'ai_agent.created', entityType: 'AiAgent', entityId: 'a1' } });
    // The provider list is global (shared platform key): agents of other organizations must not leak.
    mockNiroAi.listAgents.mockResolvedValue([
      { id: 'a1', name: 'Asesor', category: 'CHAT' },
      { id: 'other-org-agent', name: 'Ajeno', category: 'CHAT' }
    ]);

    const res = await agent.get('/api/org/ai/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].id).toBe('a1');
  });

  test('POST /agents crea un agente y lo audita, solo para roles de gestión', async () => {
    const { org, agent, csrfToken } = await setupOrg('ADMIN');
    mockNiroAi.createAgent.mockResolvedValue({ id: 'agent-1', name: 'Asesor Legal', category: 'CHAT' });

    const res = await agent
      .post('/api/org/ai/agents')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Asesor Legal', systemPrompt: 'Sos un asesor legal.' });

    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBe('agent-1');
    expect(mockNiroAi.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Asesor Legal', systemPrompt: 'Sos un asesor legal.' })
    );

    const logs = await prisma.auditLog.findMany({ where: { organizationId: org.id, action: 'ai_agent.created' } });
    expect(logs).toHaveLength(1);
  });

  test('POST /agents rechaza a un AGENT si el admin le quitó los agentes de IA', async () => {
    const { agent, csrfToken } = await setupOrg('AGENT');
    await prisma.user.updateMany({ where: { role: 'AGENT' }, data: { permissions: { aiAgents: false } } });
    const res = await agent
      .post('/api/org/ai/agents')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'X', systemPrompt: 'Y' });
    expect(res.status).toBe(403);
  });

  test('POST /agents/:id/chat conversa con un agente propio', async () => {
    const { org, agent, csrfToken } = await setupOrg('AGENT');
    await prisma.auditLog.create({ data: { organizationId: org.id, action: 'ai_agent.created', entityType: 'AiAgent', entityId: 'agent-1' } });
    mockNiroAi.chatWithAgent.mockResolvedValue({ content: 'Respuesta del agente', cost: 0.002 });

    const res = await agent
      .post('/api/org/ai/agents/agent-1/chat')
      .set('X-CSRF-Token', csrfToken)
      .send({ messages: [{ role: 'user', content: 'hola' }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Respuesta del agente');
    expect(mockNiroAi.chatWithAgent).toHaveBeenCalledWith('agent-1', [{ role: 'user', content: 'hola' }]);
  });

  test('POST /agents/:id/chat rechaza un agente de otra organización', async () => {
    const { agent, csrfToken } = await setupOrg('AGENT');
    const res = await agent
      .post('/api/org/ai/agents/agent-de-otra-org/chat')
      .set('X-CSRF-Token', csrfToken)
      .send({ messages: [{ role: 'user', content: 'hola' }] });
    expect(res.status).toBe(404);
    expect(mockNiroAi.chatWithAgent).not.toHaveBeenCalledWith('agent-de-otra-org', expect.anything());
  });

  test('POST /vision/extract exige un archivo', async () => {
    const { agent, csrfToken } = await setupOrg('AGENT');
    const res = await agent.post('/api/org/ai/vision/extract').set('X-CSRF-Token', csrfToken);
    expect(res.status).toBe(400);
  });

  test('POST /vision/extract devuelve el texto/JSON de la factura', async () => {
    const { agent, csrfToken } = await setupOrg('AGENT');
    mockNiroAi.visionExtract.mockResolvedValue({ text: '{"total":1000}', data: { total: 1000 }, cost: 0.01 });

    const res = await agent
      .post('/api/org/ai/vision/extract')
      .set('X-CSRF-Token', csrfToken)
      .field('mode', 'invoice')
      .attach('file', Buffer.from('fake-image'), { filename: 'factura.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1000);
    expect(mockNiroAi.visionExtract).toHaveBeenCalledWith(
      expect.any(Buffer),
      'factura.jpg',
      'image/jpeg',
      expect.objectContaining({ mode: 'invoice' })
    );
  });

  test('POST /documents/analyze responde la pregunta sobre el PDF', async () => {
    const { agent, csrfToken } = await setupOrg('AGENT');
    mockNiroAi.analyzeDocument.mockResolvedValue({ answer: 'Vence en 30 días', extractedChars: 500, cost: 0.004 });

    const res = await agent
      .post('/api/org/ai/documents/analyze')
      .set('X-CSRF-Token', csrfToken)
      .field('question', '¿Cuándo vence?')
      .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'contrato.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Vence en 30 días');
  });

  test('POST /audio/transcriptions devuelve el texto transcrito', async () => {
    const { agent, csrfToken } = await setupOrg('AGENT');
    mockNiroAi.transcribeAudio.mockResolvedValue({ text: 'hola esto es una prueba', seconds: 3.2, cost: 0.002 });

    const res = await agent
      .post('/api/org/ai/audio/transcriptions')
      .set('X-CSRF-Token', csrfToken)
      .attach('file', Buffer.from('fake-audio'), { filename: 'nota.ogg', contentType: 'audio/ogg' });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('hola esto es una prueba');
  });

  test('todas las rutas exigen sesión iniciada', async () => {
    const request = require('supertest');
    const res = await request(app).get('/api/org/ai/status');
    expect(res.status).toBe(401);
  });
});
