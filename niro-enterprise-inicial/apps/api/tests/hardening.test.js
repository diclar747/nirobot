const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: 'hard-co' });
  const admin = await createUser(prisma, { organizationId: org.id, email: 'admin@hard.test', role: 'ADMIN' });
  const agentA = await createUser(prisma, { organizationId: org.id, email: 'a@hard.test', role: 'AGENT' });
  const agentB = await createUser(prisma, { organizationId: org.id, email: 'b@hard.test', role: 'AGENT' });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000111' } });
  return { org, admin, agentA, agentB, contact };
}

const post = (s, path, body = {}) => s.agent.post(path).set('X-CSRF-Token', s.csrfToken).send(body);

describe('endurecimiento de permisos', () => {
  test('un AGENT no puede transferir ni aceptar la conversación asignada a otro agente', async () => {
    const { org, agentA, agentB, contact } = await setup();
    const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', assignedToId: agentB.id } });
    const session = await loginAgent(app, agentA.email);

    expect((await post(session, `/api/org/conversations/${conversation.id}/transfer`, { targetUserId: agentA.id })).status).toBe(404);
    expect((await post(session, `/api/org/conversations/${conversation.id}/transfer-response`, { action: 'accept' })).status).toBe(404);
    const unchanged = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    expect(unchanged.assignedToId).toBe(agentB.id);
  });

  test('transfer-response valida la acción', async () => {
    const { org, agentA, contact } = await setup();
    const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', assignedToId: agentA.id } });
    const session = await loginAgent(app, agentA.email);
    expect((await post(session, `/api/org/conversations/${conversation.id}/transfer-response`, { action: 'robar' })).status).toBe(400);
    expect((await post(session, `/api/org/conversations/${conversation.id}/transfer-response`, { action: 'accept' })).status).toBe(200);
  });

  test('solo supervisor o superior modifica el consentimiento de llamadas', async () => {
    const { admin, agentA, contact } = await setup();
    const agentSession = await loginAgent(app, agentA.email);
    const adminSession = await loginAgent(app, admin.email);
    const patch = (s, body) => s.agent.patch(`/api/org/contacts/${contact.id}`).set('X-CSRF-Token', s.csrfToken).send(body);

    expect((await patch(agentSession, { callConsentStatus: 'GRANTED' })).status).toBe(403);
    expect((await patch(agentSession, { name: 'Nuevo nombre' })).status).toBe(200);
    expect((await patch(adminSession, { callConsentStatus: 'INVENTADO' })).status).toBe(400);
    const granted = await patch(adminSession, { callConsentStatus: 'GRANTED' });
    expect(granted.status).toBe(200);
    expect(granted.body.contact.callConsentStatus).toBe('GRANTED');
  });

  test('un AGENT no puede crear claves API', async () => {
    const { admin, agentA } = await setup();
    const agentSession = await loginAgent(app, agentA.email);
    const adminSession = await loginAgent(app, admin.email);
    expect((await post(agentSession, '/api/org/api-keys', { name: 'x' })).status).toBe(403);
    expect((await post(adminSession, '/api/org/api-keys', { name: 'Integración' })).status).toBe(201);
  });
});

describe('entrega de mensajes por WhatsApp', () => {
  test('un texto que no sale queda marcado como fallido, no como enviado', async () => {
    const { org, agentA, contact } = await setup();
    const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', assignedToId: agentA.id } });
    const session = await loginAgent(app, agentA.email);
    const spy = jest.spyOn(whatsapp, 'sendText').mockRejectedValue(new Error('WhatsApp no esta conectado para esta organizacion'));

    const res = await post(session, `/api/org/conversations/${conversation.id}/messages`, { content: 'Hola' });
    expect(res.status).toBe(201);
    expect(res.body.message.deliveryStatus).toBe('pending');

    const deadline = Date.now() + 5000;
    let stored;
    while (Date.now() < deadline) {
      stored = await prisma.message.findUnique({ where: { id: res.body.message.id } });
      if (stored.deliveryStatus === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(stored.deliveryStatus).toBe('failed');
    spy.mockRestore();
  });
});

describe('Salud del servicio', () => {
  test('GET /api/health responde ok sin autenticación', async () => {
    const res = await require('supertest')(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
