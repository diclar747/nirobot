const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent, DEFAULT_PASSWORD, extractCookieValue } = require('./helpers/auth');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

describe('POST /api/auth/login', () => {
  test('rechaza credenciales inválidas', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });

    const res = await request(app).post('/api/auth/login').send({ email: 'owner@acme.test', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  test('rechaza usuarios inactivos', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER', active: false });

    const res = await request(app).post('/api/auth/login').send({ email: 'owner@acme.test', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('rechaza usuarios de una organización suspendida', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await prisma.organization.update({ where: { id: org.id }, data: { active: false } });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });

    const res = await request(app).post('/api/auth/login').send({ email: 'owner@acme.test', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('login correcto entrega cookies de sesión y csrf', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });

    const res = await request(app).post('/api/auth/login').send({ email: 'owner@acme.test', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('owner@acme.test');
    expect(res.body.user.passwordHash).toBeUndefined();

    const cookies = res.headers['set-cookie'];
    expect(extractCookieValue(cookies, 'niro_at')).toBeTruthy();
    expect(extractCookieValue(cookies, 'niro_rt')).toBeTruthy();
    expect(extractCookieValue(cookies, 'niro_csrf')).toBeTruthy();
  });
});

describe('GET /api/auth/me', () => {
  test('sin cookie devuelve 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('con sesión válida devuelve el usuario actual', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent } = await loginAgent(app, 'owner@acme.test');

    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('owner@acme.test');
  });
});

describe('POST /api/auth/refresh', () => {
  test('rota el refresh token y el anterior no puede reutilizarse', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });

    const loginRes = await request(app).post('/api/auth/login').send({ email: 'owner@acme.test', password: DEFAULT_PASSWORD });
    const oldRefreshToken = extractCookieValue(loginRes.headers['set-cookie'], 'niro_rt');

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${oldRefreshToken}`);
    expect(refreshRes.status).toBe(200);
    const newRefreshToken = extractCookieValue(refreshRes.headers['set-cookie'], 'niro_rt');
    expect(newRefreshToken).toBeTruthy();
    expect(newRefreshToken).not.toBe(oldRefreshToken);

    // Dentro de la ventana de gracia (pestañas concurrentes) el token viejo se rechaza sin
    // revocar la sesión nueva.
    const raceRes = await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${oldRefreshToken}`);
    expect(raceRes.status).toBe(409);
    const stillValid = await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${newRefreshToken}`);
    expect(stillValid.status).toBe(200);
    const rotatedAgain = extractCookieValue(stillValid.headers['set-cookie'], 'niro_rt');

    // Pasada la ventana, reusar un token ya rotado es robo: debe fallar y revocar toda la sesión.
    await prisma.refreshToken.updateMany({ where: { revokedAt: { not: null } }, data: { revokedAt: new Date(Date.now() - 60 * 1000) } });
    const reuseRes = await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${oldRefreshToken}`);
    expect(reuseRes.status).toBe(401);

    const newTokenNowRes = await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${rotatedAgain}`);
    expect(newTokenNowRes.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  test('revoca la sesión: el refresh token ya no sirve tras logout', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });

    const loginRes = await request(app).post('/api/auth/login').send({ email: 'owner@acme.test', password: DEFAULT_PASSWORD });
    const accessToken = extractCookieValue(loginRes.headers['set-cookie'], 'niro_at');
    const refreshToken = extractCookieValue(loginRes.headers['set-cookie'], 'niro_rt');

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', [`niro_at=${accessToken}`, `niro_rt=${refreshToken}`]);
    expect(logoutRes.status).toBe(204);

    const refreshAfterLogout = await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${refreshToken}`);
    expect(refreshAfterLogout.status).toBe(401);
  });
});
