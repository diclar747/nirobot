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

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const OGG_BUFFER = Buffer.from('fake ogg audio bytes');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
  mockNiroAi.isConfigured.mockReturnValue(true);
});

async function setupWithAttachment(buffer, filename, contentType) {
  const org = await createOrganization(prisma, { slug: 'ai-read' });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner-${Date.now()}@ai-read.test`, role: 'OWNER' });
  const { agent, csrfToken } = await loginAgent(app, owner.email);

  const conv = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'Cliente' } });
  const conversationId = conv.body.conversation.id;

  const upload = await agent
    .post(`/api/org/conversations/${conversationId}/attachments`)
    .set('X-CSRF-Token', csrfToken)
    .attach('file', buffer, { filename, contentType });

  return { agent, csrfToken, conversationId, messageId: upload.body.message.id };
}

describe('Lectura con IA de adjuntos ya guardados', () => {
  test('transcribe un audio existente y lo guarda en el mensaje', async () => {
    const { agent, csrfToken, conversationId, messageId } = await setupWithAttachment(OGG_BUFFER, 'nota.ogg', 'audio/ogg');
    mockNiroAi.transcribeAudio.mockResolvedValue({ text: 'hola esto es una nota de voz', seconds: 2.1, cost: 0.001 });

    const res = await agent
      .post(`/api/org/conversations/${conversationId}/messages/${messageId}/ai-read`)
      .set('X-CSRF-Token', csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.message.transcription).toBe('hola esto es una nota de voz');
    expect(mockNiroAi.transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'nota.ogg', 'audio/ogg');
    expect(mockNiroAi.visionExtract).not.toHaveBeenCalled();
  });

  test('lee una imagen en modo factura y devuelve el JSON estructurado', async () => {
    const { agent, csrfToken, conversationId, messageId } = await setupWithAttachment(PNG_BUFFER, 'factura.png', 'image/png');
    mockNiroAi.visionExtract.mockResolvedValue({ text: '{"total":5000}', data: { total: 5000 }, cost: 0.01 });

    const res = await agent
      .post(`/api/org/conversations/${conversationId}/messages/${messageId}/ai-read`)
      .set('X-CSRF-Token', csrfToken)
      .send({ mode: 'invoice' });

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(5000);
    expect(res.body.message.transcription).toBe('{"total":5000}');
    expect(mockNiroAi.visionExtract).toHaveBeenCalledWith(expect.any(Buffer), 'factura.png', 'image/png', { mode: 'invoice' });
  });

  test('rechaza un mensaje sin adjunto', async () => {
    const org = await createOrganization(prisma, { slug: 'ai-read-2' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@ai-read-2.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);
    const conv = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'Cliente' } });
    const conversationId = conv.body.conversation.id;
    const msg = await agent
      .post(`/api/org/conversations/${conversationId}/messages`)
      .set('X-CSRF-Token', csrfToken)
      .send({ content: 'sin adjunto', type: 'outbound' });

    const res = await agent
      .post(`/api/org/conversations/${conversationId}/messages/${msg.body.message.id}/ai-read`)
      .set('X-CSRF-Token', csrfToken)
      .send({});
    expect(res.status).toBe(400);
  });

  test('responde 503 si Niro IA no está configurada', async () => {
    mockNiroAi.isConfigured.mockReturnValue(false);
    const { agent, csrfToken, conversationId, messageId } = await setupWithAttachment(OGG_BUFFER, 'nota.ogg', 'audio/ogg');

    const res = await agent
      .post(`/api/org/conversations/${conversationId}/messages/${messageId}/ai-read`)
      .set('X-CSRF-Token', csrfToken)
      .send({});
    expect(res.status).toBe(503);
    expect(mockNiroAi.transcribeAudio).not.toHaveBeenCalled();
  });
});
