const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const realtime = require('../src/lib/realtime');

let org, admin, adminUser, agentUser;
beforeAll(async () => {
  await resetDb();
  org = await createOrganization(prisma, { slug: `pr-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  adminUser = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@pr.test`, role: 'OWNER' });
  agentUser = await createUser(prisma, { organizationId: org.id, email: `a${Date.now()}@pr.test`, role: 'AGENT' });
  admin = await loginAgent(app, adminUser.email);
});
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

const who = (u) => ({ id: u.id, name: u.email.split('@')[0], email: u.email, role: u.role });
const entryOf = (u) => realtime.getOrgPresenceList(org.id).find((p) => p.userId === u.id);

describe('Presencia de agentes', () => {
  test('al conectarse queda en línea (Disponible) y al cerrar la última pestaña pasa a desconectado', () => {
    realtime.registerPresence(org.id, agentUser.id, who(agentUser), 's1');
    expect(entryOf(agentUser)).toMatchObject({ status: 'available', online: true });
    realtime.registerPresence(org.id, agentUser.id, who(agentUser), 's2');
    realtime.releasePresence(org.id, agentUser.id, 's1');
    expect(entryOf(agentUser)).toMatchObject({ status: 'available', online: true }); // queda otra pestaña
    realtime.releasePresence(org.id, agentUser.id, 's2');
    expect(entryOf(agentUser)).toBeUndefined(); // sin pestañas no aparece como en línea
  });

  test('puede elegir Ocupado, Pendiente, Receso o Descanso y lo recuerda al reconectarse', () => {
    realtime.registerPresence(org.id, adminUser.id, who(adminUser), 'a1');
    for (const status of ['busy', 'pending', 'break', 'rest', 'away', 'available']) {
      expect(realtime.setAgentPresenceStatus(org.id, adminUser.id, status)).toBe(true);
      expect(entryOf(adminUser).status).toBe(status);
    }
    realtime.setAgentPresenceStatus(org.id, adminUser.id, 'break');
    realtime.releasePresence(org.id, adminUser.id, 'a1');
    expect(entryOf(adminUser)).toBeUndefined();
    realtime.registerPresence(org.id, adminUser.id, who(adminUser), 'a2'); // vuelve a abrir la pestaña
    expect(entryOf(adminUser)).toMatchObject({ status: 'break', online: true }); // no queda "desconectado"
    realtime.releasePresence(org.id, adminUser.id, 'a2');
  });

  test('un estado inválido se rechaza y no se puede fijar sin estar conectado', () => {
    expect(realtime.setAgentPresenceStatus(org.id, agentUser.id, 'offline')).toBe(false);
    expect(realtime.setAgentPresenceStatus(org.id, agentUser.id, 'volando')).toBe(false);
    expect(realtime.setAgentPresenceStatus(org.id, agentUser.id, 'busy')).toBe(false); // sin pestañas
  });

  test('la API acepta los estados nuevos y rechaza los inválidos; la lista muestra a quien está conectado', async () => {
    realtime.registerPresence(org.id, adminUser.id, who(adminUser), 'a3');
    const csrf = { 'X-CSRF-Token': admin.csrfToken };
    const ok = await admin.agent.post('/api/org/presence/status').set(csrf).send({ status: 'rest' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'rest', applied: true });
    expect((await admin.agent.post('/api/org/presence/status').set(csrf).send({ status: 'nada' })).status).toBe(400);
    const list = await admin.agent.get('/api/org/presence');
    expect(list.body.presence.find((p) => p.userId === adminUser.id)).toMatchObject({ status: 'rest', online: true, role: 'OWNER' });
    realtime.releasePresence(org.id, adminUser.id, 'a3');
  });
});
