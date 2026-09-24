const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { toNotification } = require('../src/lib/facebookBridge');

// Módulo Facebook / Instagram: acceso por organización habilitada + rol + plan (lib/facebookPanel.js,
// /api/facebook/authz que consulta nginx) y bloqueo de la API pública con el plan vencido.
const ENV = { ...process.env };

afterAll(async () => {
  process.env = ENV;
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  process.env.FACEBOOK_PANEL_PASSWORD = 'panel-secret';
});

async function orgWith(role, orgData = {}) {
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const organization = await createOrganization(prisma, { slug: `fb-${suffix}` });
  await prisma.organization.update({ where: { id: organization.id }, data: { trialEndsAt: new Date(Date.now() + 3600 * 1000), ...orgData } });
  const user = await createUser(prisma, { organizationId: organization.id, email: `${role.toLowerCase()}${suffix}@fb.test`, role });
  const session = await loginAgent(app, user.email);
  return { organization, ...session };
}

describe('acceso al panel de Facebook / Instagram', () => {
  test('solo dueños/admins de organizaciones habilitadas', async () => {
    const allowed = await orgWith('OWNER');
    const other = await orgWith('OWNER');
    process.env.FACEBOOK_PANEL_ORG_IDS = allowed.organization.id;
    const agentUser = await createUser(prisma, { organizationId: allowed.organization.id, email: `agent${Date.now()}@fb.test`, role: 'AGENT' });
    const agent = await loginAgent(app, agentUser.email);

    expect((await allowed.agent.get('/api/org/facebook/status')).body).toEqual({ enabled: true });
    expect((await other.agent.get('/api/org/facebook/status')).body).toEqual({ enabled: false });
    expect((await agent.agent.get('/api/org/facebook/status')).body).toEqual({ enabled: false });

    expect((await allowed.agent.get('/api/facebook/authz')).status).toBe(204);
    expect((await other.agent.get('/api/facebook/authz')).status).toBe(403);
    expect((await agent.agent.get('/api/facebook/authz')).status).toBe(403);
    expect((await request(app).get('/api/facebook/authz')).status).toBe(401);
    expect((await other.agent.get('/api/org/facebook/open')).status).toBe(403);
  });

  test('sin lista (o "*") lo tiene cada organización, con su propio panel', async () => {
    const a = await orgWith('OWNER');
    const b = await orgWith('ADMIN');
    for (const value of [undefined, '*']) {
      if (value === undefined) delete process.env.FACEBOOK_PANEL_ORG_IDS; else process.env.FACEBOOK_PANEL_ORG_IDS = value;
      expect((await a.agent.get('/api/org/facebook/status')).body).toEqual({ enabled: true });
      const authzA = await a.agent.get('/api/facebook/authz');
      const authzB = await b.agent.get('/api/facebook/authz');
      expect(authzA.status).toBe(204);
      // nginx usa este header para mandar a cada organización a SU panel.
      expect(authzA.headers['x-niro-org']).toBe(a.organization.id);
      expect(authzB.headers['x-niro-org']).toBe(b.organization.id);
    }
  });

  test('supervisor: consulta interna de planes vencidos (con la contraseña técnica)', async () => {
    const ok = await orgWith('OWNER');
    const expired = await orgWith('OWNER', { trialEndsAt: new Date(Date.now() - 1000), paidUntil: null });
    const ids = [ok.organization.id, expired.organization.id, 'no-existe-123'];
    const denied = await request(app).post('/api/facebook/internal/plan-status').send({ orgIds: ids });
    expect(denied.status).toBe(403);
    const res = await request(app).post('/api/facebook/internal/plan-status').set('x-niro-internal', 'panel-secret').send({ orgIds: ids });
    expect(res.status).toBe(200);
    expect(res.body.blocked.sort()).toEqual([expired.organization.id, 'no-existe-123'].sort());
  });

  test('prueba vencida y sin plan: el panel se cierra (403 para nginx)', async () => {
    const expired = await orgWith('OWNER', { trialEndsAt: new Date(Date.now() - 1000), paidUntil: null });
    process.env.FACEBOOK_PANEL_ORG_IDS = expired.organization.id;
    expect((await expired.agent.get('/api/facebook/authz')).status).toBe(403);
    expect((await expired.agent.get('/api/org/facebook/status')).status).toBe(402);
  });

  test('con plan pago vuelve a abrir', async () => {
    const paid = await orgWith('ADMIN', { trialEndsAt: new Date(Date.now() - 1000), paidUntil: new Date(Date.now() + 86400000) });
    process.env.FACEBOOK_PANEL_ORG_IDS = paid.organization.id;
    expect((await paid.agent.get('/api/facebook/authz')).status).toBe(204);
  });
});

describe('API pública con el plan vencido', () => {
  test('la API key responde 402 SUBSCRIPTION_REQUIRED', async () => {
    const { organization, agent, csrfToken } = await orgWith('OWNER');
    const created = await agent.post('/api/org/api-keys').set('X-CSRF-Token', csrfToken).send({ name: 'ERP' });
    const secret = created.body.secret;
    expect(secret).toBeTruthy();
    const ok = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${secret}`);
    expect(ok.status).toBe(200);

    await prisma.organization.update({ where: { id: organization.id }, data: { trialEndsAt: new Date(Date.now() - 1000), paidUntil: null } });
    require('../src/lib/billing').clearBlockedCache(organization.id);
    const blocked = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${secret}`);
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('avisos de Facebook para la campana', () => {
  test('mensajes van a Messenger y el resto a Notificaciones', () => {
    expect(toNotification({ id: '1', kind: 'message', text: 'Hola  quiero precio' })).toMatchObject({ title: 'Mensaje de Messenger', body: 'Hola quiero precio', section: 'messenger' });
    expect(toNotification({ id: '2', kind: 'comment', text: 'x'.repeat(200) })).toMatchObject({ title: 'Comentario en Facebook', section: 'notificaciones' });
    expect(toNotification({ id: '2', kind: 'comment', text: 'x'.repeat(200) }).body.length).toBe(141);
  });
});
