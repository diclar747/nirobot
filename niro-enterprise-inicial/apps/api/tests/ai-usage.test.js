const mockNiroAi = {
  isConfigured: jest.fn(() => true),
  chatCompletion: jest.fn(),
  transcribeAudio: jest.fn(),
  visionExtract: jest.fn(),
  analyzeDocument: jest.fn(),
  listAgents: jest.fn(),
  createAgent: jest.fn(),
  chatWithAgent: jest.fn()
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

async function setupOrg() {
  const org = await createOrganization(prisma, { slug: 'usage-co' });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner-${Date.now()}@usage.test`, role: 'OWNER' });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { org, owner, agent, csrfToken };
}

describe('Registro y resumen de uso de IA', () => {
  test('cada llamada exitosa queda registrada con su tipo y costo', async () => {
    const { org, agent, csrfToken } = await setupOrg();
    mockNiroAi.chatCompletion.mockResolvedValue({ content: 'hola', cost: 0.5 });
    mockNiroAi.chatWithAgent.mockResolvedValue({ content: 'respuesta', cost: 1.25 });

    await agent.post('/api/org/ai/chat/test').set('X-CSRF-Token', csrfToken).send({ message: 'hola' });
    await agent
      .post('/api/org/ai/agents/agent-1/chat')
      .set('X-CSRF-Token', csrfToken)
      .send({ messages: [{ role: 'user', content: 'hola' }] });

    const logs = await prisma.aiUsageLog.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[0].kind).toBe('chat_test');
    expect(Number(logs[0].cost)).toBe(0.5);
    expect(logs[1].kind).toBe('agent_chat');
    expect(Number(logs[1].cost)).toBe(1.25);
  });

  test('una llamada sin costo (null) igual queda registrada, sin costo', async () => {
    const { org, agent, csrfToken } = await setupOrg();
    mockNiroAi.chatCompletion.mockResolvedValue({ content: 'hola', cost: null });

    await agent.post('/api/org/ai/chat/test').set('X-CSRF-Token', csrfToken).send({ message: 'hola' });

    const logs = await prisma.aiUsageLog.findMany({ where: { organizationId: org.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].cost).toBeNull();
  });

  test('GET /usage/summary agrupa por tipo y respeta la ventana de días', async () => {
    const { org, agent } = await setupOrg();
    await prisma.aiUsageLog.createMany({
      data: [
        { organizationId: org.id, kind: 'chat', cost: 1 },
        { organizationId: org.id, kind: 'chat', cost: 2 },
        { organizationId: org.id, kind: 'vision', cost: null },
        { organizationId: org.id, kind: 'chat', cost: 3, createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) }
      ]
    });

    const res = await agent.get('/api/org/ai/usage/summary?days=30');
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(3);

    const chat = res.body.byKind.find((k) => k.kind === 'chat');
    expect(chat.calls).toBe(2);
    expect(chat.cost).toBe(3);

    const vision = res.body.byKind.find((k) => k.kind === 'vision');
    expect(vision.calls).toBe(1);
    expect(vision.cost).toBeNull();
  });

  test('el resumen de una organización nunca incluye el uso de otra', async () => {
    const { org: orgA, agent: agentA } = await setupOrg();
    const orgB = await createOrganization(prisma, { slug: 'usage-co-b' });
    await prisma.aiUsageLog.createMany({
      data: [
        { organizationId: orgA.id, kind: 'chat', cost: 1 },
        { organizationId: orgB.id, kind: 'chat', cost: 999 }
      ]
    });

    const res = await agentA.get('/api/org/ai/usage/summary?days=30');
    expect(res.body.totalCalls).toBe(1);
    expect(res.body.byKind.find((k) => k.kind === 'chat').cost).toBe(1);
  });
});
