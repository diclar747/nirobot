const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
// testApp must load first: it sets process.env.JWT_SECRET/DATABASE_URL before anything
// requires src/app.js (testServer.js requires it too, and tokens.js reads env at import time).
const { prisma, resetDb } = require('./helpers/testApp');
const { startTestServer } = require('./helpers/testServer');
const { createOrganization, createUser, extractCookieValue, DEFAULT_PASSWORD } = require('./helpers/auth');

let testServer;

beforeAll(async () => {
  testServer = await startTestServer();
});

afterAll(async () => {
  await testServer.close();
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

function connectSocket(baseUrl, accessToken) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: `niro_at=${accessToken}` },
      reconnection: false
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

test(
  'un mensaje creado en la organización A solo notifica al socket de la organización A, nunca al de B',
  async () => {
    const orgA = await createOrganization(prisma, { slug: 'org-a' });
    const orgB = await createOrganization(prisma, { slug: 'org-b' });
    const ownerA = await createUser(prisma, { organizationId: orgA.id, email: 'owner@org-a.test', role: 'OWNER' });
    const ownerB = await createUser(prisma, { organizationId: orgB.id, email: 'owner@org-b.test', role: 'OWNER' });

    const loginA = await request(testServer.server).post('/api/auth/login').send({ email: ownerA.email, password: DEFAULT_PASSWORD });
    const loginB = await request(testServer.server).post('/api/auth/login').send({ email: ownerB.email, password: DEFAULT_PASSWORD });

    const tokenA = extractCookieValue(loginA.headers['set-cookie'], 'niro_at');
    const csrfA = extractCookieValue(loginA.headers['set-cookie'], 'niro_csrf');
    const tokenB = extractCookieValue(loginB.headers['set-cookie'], 'niro_at');

    const socketA = await connectSocket(testServer.baseUrl, tokenA);
    const socketB = await connectSocket(testServer.baseUrl, tokenB);

    const receivedByA = [];
    const receivedByB = [];
    socketA.on('message:new', (payload) => receivedByA.push(payload));
    socketB.on('message:new', (payload) => receivedByB.push(payload));

    const convRes = await request(testServer.server)
      .post('/api/org/conversations')
      .set('Cookie', [`niro_at=${tokenA}`, `niro_csrf=${csrfA}`])
      .set('X-CSRF-Token', csrfA)
      .send({ newContact: { name: 'Cliente A' } });
    expect(convRes.status).toBe(201);

    const msgRes = await request(testServer.server)
      .post(`/api/org/conversations/${convRes.body.conversation.id}/messages`)
      .set('Cookie', [`niro_at=${tokenA}`, `niro_csrf=${csrfA}`])
      .set('X-CSRF-Token', csrfA)
      .send({ content: 'Hola desde A' });
    expect(msgRes.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(receivedByA).toHaveLength(1);
    expect(receivedByA[0].message.content).toBe('Hola desde A');
    expect(receivedByB).toHaveLength(0);

    socketA.disconnect();
    socketB.disconnect();
  },
  15000
);

test('un socket sin cookie de sesión válida no puede conectarse', async () => {
  await expect(connectSocket(testServer.baseUrl, 'token-invalido')).rejects.toBeTruthy();
});

function connectWidgetSocket(baseUrl, widgetToken) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { transports: ['websocket'], auth: { widgetToken }, reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

test('el socket del widget solo recibe eventos de su propia conversación, nunca de otra', async () => {
  await createOrganization(prisma, { slug: 'acme' });

  const startX = await request(testServer.server).post('/api/public/widget/acme/start').send({ name: 'Visitante X' });
  const startY = await request(testServer.server).post('/api/public/widget/acme/start').send({ name: 'Visitante Y' });

  const socketX = await connectWidgetSocket(testServer.baseUrl, startX.body.token);
  const socketY = await connectWidgetSocket(testServer.baseUrl, startY.body.token);

  const receivedByX = [];
  const receivedByY = [];
  socketX.on('message:new', (payload) => receivedByX.push(payload));
  socketY.on('message:new', (payload) => receivedByY.push(payload));

  const msgRes = await request(testServer.server)
    .post('/api/public/widget/acme/messages')
    .send({ token: startX.body.token, content: 'Mensaje de X' });
  expect(msgRes.status).toBe(201);

  await new Promise((resolve) => setTimeout(resolve, 400));

  expect(receivedByX).toHaveLength(1);
  expect(receivedByX[0].message.content).toBe('Mensaje de X');
  expect(receivedByY).toHaveLength(0);

  socketX.disconnect();
  socketY.disconnect();
});

test('un socket con un widgetToken inventado no puede conectarse', async () => {
  await expect(connectWidgetSocket(testServer.baseUrl, 'token-que-no-existe')).rejects.toBeTruthy();
});
