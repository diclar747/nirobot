const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { effectivePermissions, KEYS } = require('../src/lib/permissions');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function team() {
  const org = await createOrganization(prisma, { slug: `pm-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true, maxUsers: 20 } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `own${Date.now()}@pm.test`, role: 'OWNER' });
  const agentUser = await createUser(prisma, { organizationId: org.id, email: `ag${Date.now()}@pm.test`, role: 'AGENT' });
  return { org, owner, agentUser, admin: await loginAgent(app, owner.email), agent: await loginAgent(app, agentUser.email) };
}

describe('Permisos por usuario', () => {
  test('por defecto un agente puede TODO (campañas, llamadas, reportes, CRM…) y no ve la parte de administración', async () => {
    const { agent } = await team();
    for (const path of ['/api/org/campaigns', '/api/org/reports/summary', '/api/org/wa-calls/campaigns', '/api/org/orders', '/api/org/contacts/directory', '/api/org/bot-flow']) {
      const res = await agent.agent.get(path);
      expect([path, res.status]).not.toEqual([path, 403]);
    }
    expect(agent.user.permissions).toEqual(Object.fromEntries(KEYS.map((k) => [k, true])));
    // lo administrativo sigue siendo solo del admin
    expect((await agent.agent.get('/api/org/users')).status).toBe(403);
    expect((await agent.agent.post('/api/org/billing/checkout').set('X-CSRF-Token', agent.csrfToken).send({ planId: 'plan-basico' })).status).toBe(403);
    expect((await agent.agent.get('/api/org/billing/plans')).status).toBe(403);
  });

  test('el admin restringe funciones y se aplican al instante en el servidor', async () => {
    const { agentUser, admin, agent } = await team();
    const patch = await admin.agent.patch(`/api/org/users/${agentUser.id}`).set('X-CSRF-Token', admin.csrfToken).send({ permissions: { campaigns: false, reports: false, calls: true } });
    expect(patch.status).toBe(200);
    expect(patch.body.user.permissions.campaigns).toBe(false);
    expect(patch.body.user.permissions.calls).toBe(true);

    const blocked = await agent.agent.get('/api/org/campaigns');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/administrador/);
    expect((await agent.agent.post('/api/org/campaigns').set('X-CSRF-Token', agent.csrfToken).send({ name: 'x', message: 'y', contactIds: ['z'] })).status).toBe(403);
    expect((await agent.agent.get('/api/org/reports/summary')).status).toBe(403);
    expect((await agent.agent.get('/api/org/wa-calls/campaigns')).status).not.toBe(403); // sigue habilitado
    expect((await agent.agent.get('/api/auth/me')).body.user.permissions.campaigns).toBe(false);

    // "Activar todo" (mapa vacío) devuelve el acceso completo
    await admin.agent.patch(`/api/org/users/${agentUser.id}`).set('X-CSRF-Token', admin.csrfToken).send({ permissions: {} });
    expect((await agent.agent.get('/api/org/campaigns')).status).toBe(200);
  });

  test('descargar/eliminar contactos y transferir chats se controlan por separado', async () => {
    const { org, agentUser, admin, agent } = await team();
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana', phone: '595981000001' } });
    await admin.agent.patch(`/api/org/users/${agentUser.id}`).set('X-CSRF-Token', admin.csrfToken).send({ permissions: { contactsExport: false, contactsDelete: false } });
    expect((await agent.agent.get('/api/org/contacts/export.csv')).status).toBe(403);
    expect((await agent.agent.delete(`/api/org/contacts/${contact.id}`).set('X-CSRF-Token', agent.csrfToken)).status).toBe(403);
    expect((await agent.agent.get('/api/org/contacts/directory')).status).toBe(200); // ver sigue permitido
    await admin.agent.patch(`/api/org/users/${agentUser.id}`).set('X-CSRF-Token', admin.csrfToken).send({ permissions: { contactsDelete: true } });
    expect((await agent.agent.delete(`/api/org/contacts/${contact.id}`).set('X-CSRF-Token', agent.csrfToken)).status).toBe(200);
  });

  test('propietario y administrador no se pueden restringir', async () => {
    const { org, owner, admin } = await team();
    const adminUser = await createUser(prisma, { organizationId: org.id, email: `adm${Date.now()}@pm.test`, role: 'ADMIN' });
    const res = await admin.agent.patch(`/api/org/users/${adminUser.id}`).set('X-CSRF-Token', admin.csrfToken).send({ permissions: { campaigns: false } });
    expect(res.status).toBe(400);
    expect(effectivePermissions({ role: 'ADMIN', permissions: { campaigns: false } }).campaigns).toBe(true);
    expect(effectivePermissions({ role: 'OWNER', permissions: { reports: false } }).reports).toBe(true);
    expect(owner.id).toBeTruthy();
  });

  test('un agente no puede darse permisos a sí mismo ni ver el catálogo de otros', async () => {
    const { agentUser, agent } = await team();
    const res = await agent.agent.patch(`/api/org/users/${agentUser.id}`).set('X-CSRF-Token', agent.csrfToken).send({ permissions: {} });
    expect(res.status).toBe(403);
  });

  test('a agentes el estado del plan no les expone precios ni pagos', async () => {
    const { agent, admin } = await team();
    const asAgent = await agent.agent.get('/api/org/billing/status');
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.restricted).toBe(true);
    expect(asAgent.body.payments).toEqual([]);
    expect(asAgent.body.access.priceGs).toBe(0);
    const asAdmin = await admin.agent.get('/api/org/billing/status');
    expect(asAdmin.body.access.priceGs).toBeGreaterThan(0);
  });
});
