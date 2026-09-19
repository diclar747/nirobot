const mockSendNotification = jest.fn();
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: (...args) => mockSendNotification(...args)
}));

const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const push = require('../src/lib/push');

const VALID_ENV = {
  VAPID_PUBLIC_KEY: 'test-public-key',
  VAPID_PRIVATE_KEY: 'test-private-key',
  VAPID_SUBJECT: 'mailto:test@example.com'
};

function enableVapid() {
  Object.assign(process.env, VALID_ENV);
}

function disableVapid() {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
}

const SAMPLE_SUBSCRIPTION = {
  endpoint: 'https://push.example.com/abc123',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' }
};

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
  disableVapid();
});

async function setupOrg(role = 'AGENT') {
  const org = await createOrganization(prisma, { slug: 'push-co' });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner-${Date.now()}@push.test`, role });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { org, owner, agent, csrfToken };
}

describe('Notificaciones push — rutas', () => {
  test('GET /vapid-public-key devuelve null sin claves configuradas', async () => {
    const { agent } = await setupOrg();
    const res = await agent.get('/api/org/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.publicKey).toBeNull();
  });

  test('GET /vapid-public-key devuelve la clave pública cuando está configurada', async () => {
    enableVapid();
    const { agent } = await setupOrg();
    const res = await agent.get('/api/org/push/vapid-public-key');
    expect(res.body.configured).toBe(true);
    expect(res.body.publicKey).toBe('test-public-key');
  });

  test('POST /subscribe guarda la suscripción del usuario', async () => {
    enableVapid();
    const { owner, agent, csrfToken } = await setupOrg();

    const res = await agent
      .post('/api/org/push/subscribe')
      .set('X-CSRF-Token', csrfToken)
      .send({ subscription: SAMPLE_SUBSCRIPTION });

    expect(res.status).toBe(201);
    const saved = await prisma.pushSubscription.findUnique({ where: { endpoint: SAMPLE_SUBSCRIPTION.endpoint } });
    expect(saved).toBeTruthy();
    expect(saved.userId).toBe(owner.id);
  });

  test('POST /subscribe responde 503 si las notificaciones no están configuradas', async () => {
    const { agent, csrfToken } = await setupOrg();
    const res = await agent
      .post('/api/org/push/subscribe')
      .set('X-CSRF-Token', csrfToken)
      .send({ subscription: SAMPLE_SUBSCRIPTION });
    expect(res.status).toBe(503);
  });

  test('POST /subscribe rechaza una suscripción sin las claves p256dh/auth', async () => {
    enableVapid();
    const { agent, csrfToken } = await setupOrg();
    const res = await agent
      .post('/api/org/push/subscribe')
      .set('X-CSRF-Token', csrfToken)
      .send({ subscription: { endpoint: 'https://push.example.com/x' } });
    expect(res.status).toBe(400);
  });

  test('DELETE /subscribe borra la suscripción del usuario', async () => {
    enableVapid();
    const { owner, agent, csrfToken } = await setupOrg();
    await prisma.pushSubscription.create({
      data: { userId: owner.id, endpoint: SAMPLE_SUBSCRIPTION.endpoint, p256dh: 'a', auth: 'b' }
    });

    const res = await agent.delete('/api/org/push/subscribe').set('X-CSRF-Token', csrfToken).send({ endpoint: SAMPLE_SUBSCRIPTION.endpoint });
    expect(res.status).toBe(200);
    const saved = await prisma.pushSubscription.findUnique({ where: { endpoint: SAMPLE_SUBSCRIPTION.endpoint } });
    expect(saved).toBeNull();
  });

  test('DELETE /subscribe no borra la suscripción de otro usuario', async () => {
    enableVapid();
    const { org, agent, csrfToken } = await setupOrg();
    const other = await createUser(prisma, { organizationId: org.id, email: 'otro@push.test', role: 'AGENT' });
    await prisma.pushSubscription.create({
      data: { userId: other.id, endpoint: SAMPLE_SUBSCRIPTION.endpoint, p256dh: 'a', auth: 'b' }
    });

    await agent.delete('/api/org/push/subscribe').set('X-CSRF-Token', csrfToken).send({ endpoint: SAMPLE_SUBSCRIPTION.endpoint });
    const saved = await prisma.pushSubscription.findUnique({ where: { endpoint: SAMPLE_SUBSCRIPTION.endpoint } });
    expect(saved).toBeTruthy();
  });

  test('todas las rutas exigen sesión iniciada', async () => {
    const request = require('supertest');
    const res = await request(app).get('/api/org/push/vapid-public-key');
    expect(res.status).toBe(401);
  });
});

describe('Notificaciones push — lógica de envío (src/lib/push.js)', () => {
  test('sendToUser manda una notificación por cada suscripción del usuario', async () => {
    enableVapid();
    mockSendNotification.mockResolvedValue({});
    const { owner } = await setupOrg();
    await prisma.pushSubscription.createMany({
      data: [
        { userId: owner.id, endpoint: 'https://push.example.com/1', p256dh: 'a', auth: 'b' },
        { userId: owner.id, endpoint: 'https://push.example.com/2', p256dh: 'c', auth: 'd' }
      ]
    });

    await push.sendToUser(owner.id, { title: 'Hola' });
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });

  test('sendToUser no manda nada sin claves VAPID configuradas', async () => {
    const { owner } = await setupOrg();
    await prisma.pushSubscription.create({
      data: { userId: owner.id, endpoint: 'https://push.example.com/1', p256dh: 'a', auth: 'b' }
    });
    await push.sendToUser(owner.id, { title: 'Hola' });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  test('una suscripción vencida (410) se borra sola sin romper el envío a las demás', async () => {
    enableVapid();
    const { owner } = await setupOrg();
    await prisma.pushSubscription.createMany({
      data: [
        { userId: owner.id, endpoint: 'https://push.example.com/expired', p256dh: 'a', auth: 'b' },
        { userId: owner.id, endpoint: 'https://push.example.com/valid', p256dh: 'c', auth: 'd' }
      ]
    });
    mockSendNotification.mockImplementation((sub) => {
      if (sub.endpoint.endsWith('/expired')) {
        const err = new Error('gone');
        err.statusCode = 410;
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    await push.sendToUser(owner.id, { title: 'Hola' });

    const remaining = await prisma.pushSubscription.findMany({ where: { userId: owner.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].endpoint).toBe('https://push.example.com/valid');
  });

  test('notifyNewInboundMessage avisa al agente asignado y no a los managers', async () => {
    enableVapid();
    mockSendNotification.mockResolvedValue({});
    const { org, owner } = await setupOrg('OWNER');
    const agentUser = await createUser(prisma, { organizationId: org.id, email: 'agente@push.test', role: 'AGENT' });
    await prisma.pushSubscription.create({
      data: { userId: agentUser.id, endpoint: 'https://push.example.com/agent', p256dh: 'a', auth: 'b' }
    });
    await prisma.pushSubscription.create({
      data: { userId: owner.id, endpoint: 'https://push.example.com/owner', p256dh: 'a', auth: 'b' }
    });

    await push.notifyNewInboundMessage({
      organizationId: org.id,
      conversation: { id: 'conv-1', assignedToId: agentUser.id },
      contactLabel: 'Cliente',
      preview: 'hola',
      channel: 'whatsapp'
    });

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const [subscriptionArg] = mockSendNotification.mock.calls[0];
    expect(subscriptionArg.endpoint).toBe('https://push.example.com/agent');
  });

  test('notifyNewInboundMessage avisa a los managers cuando la conversación no está asignada', async () => {
    enableVapid();
    mockSendNotification.mockResolvedValue({});
    const { org, owner } = await setupOrg('OWNER');
    await prisma.pushSubscription.create({
      data: { userId: owner.id, endpoint: 'https://push.example.com/owner', p256dh: 'a', auth: 'b' }
    });

    await push.notifyNewInboundMessage({
      organizationId: org.id,
      conversation: { id: 'conv-2', assignedToId: null },
      contactLabel: 'Cliente',
      preview: 'hola',
      channel: 'whatsapp'
    });

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
  });
});
