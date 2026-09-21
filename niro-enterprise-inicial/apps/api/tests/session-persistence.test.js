const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, DEFAULT_PASSWORD, extractCookieValue } = require('./helpers/auth');

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `sp-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const user = await createUser(prisma, { organizationId: org.id, email: `u${Date.now()}@sp.test`, role: 'OWNER' });
  return { org, user };
}

const cookieLine = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`)) || '';
const maxAgeDays = (line) => Number((/Max-Age=(\d+)/i.exec(line) || [])[1]) / 86400;

describe('Persistencia de sesión (el navegador se cierra y se vuelve a abrir)', () => {
  test('las cookies de sesión son persistentes: la de renovación y la CSRF duran 30 días', async () => {
    const { user } = await setup();
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(maxAgeDays(cookieLine(res, 'niro_rt'))).toBeCloseTo(30, 0);
    expect(maxAgeDays(cookieLine(res, 'niro_csrf'))).toBeCloseTo(30, 0);
    expect(maxAgeDays(cookieLine(res, 'niro_at')) * 24 * 60).toBeCloseTo(15, 0); // acceso: 15 minutos
  });

  test('sin la cookie de acceso vencida, /me da 401 pero /refresh devuelve la sesión y /me vuelve a andar', async () => {
    const { user } = await setup();
    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });
    const refreshToken = extractCookieValue(login.headers['set-cookie'], 'niro_rt');

    // El navegador estuvo cerrado más de 15 minutos: solo queda la cookie de renovación.
    const browser = request.agent(app);
    const onlyRefresh = `niro_rt=${refreshToken}`;
    const me = await browser.get('/api/auth/me').set('Cookie', onlyRefresh);
    expect(me.status).toBe(401);

    const renewed = await browser.post('/api/auth/refresh').set('Cookie', onlyRefresh);
    expect(renewed.status).toBe(200);
    expect(renewed.body.user.email).toBe(user.email);
    expect(cookieLine(renewed, 'niro_at')).toBeTruthy();
    // la cookie de renovación se rota y sigue siendo persistente
    expect(maxAgeDays(cookieLine(renewed, 'niro_rt'))).toBeCloseTo(30, 0);

    expect((await browser.get('/api/auth/me')).status).toBe(200);
  });

  test('una renovación válida no cierra la sesión aunque pasen días; una revocada sí la rechaza', async () => {
    const { user } = await setup();
    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });
    const refreshToken = extractCookieValue(login.headers['set-cookie'], 'niro_rt');
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() + 20 * 24 * 3600 * 1000) } }); // faltan 20 días
    expect((await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${refreshToken}`)).status).toBe(200);

    await prisma.refreshToken.updateMany({ data: { revokedAt: new Date(Date.now() - 60000) } });
    expect((await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${refreshToken}`)).status).toBe(401);
  });

  test('cerrar sesión con la cookie de acceso vencida igual revoca la renovación y limpia las cookies', async () => {
    const { user } = await setup();
    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });
    const refreshToken = extractCookieValue(login.headers['set-cookie'], 'niro_rt');
    const out = await request(app).post('/api/auth/logout').set('Cookie', `niro_rt=${refreshToken}`);
    expect(out.status).toBe(204);
    expect(cookieLine(out, 'niro_rt')).toMatch(/Expires=Thu, 01 Jan 1970/i);
    // ya no se puede volver a entrar con esa renovación
    expect((await request(app).post('/api/auth/refresh').set('Cookie', `niro_rt=${refreshToken}`)).status).toBeGreaterThanOrEqual(401);
    expect(await prisma.auditLog.findFirst({ where: { action: 'auth.logout', entityId: user.id } })).toBeTruthy();
  });
});
