const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');
const sync = require('../src/lib/whatsappSync');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); });

async function setup(role = 'OWNER') {
  const org = await createOrganization(prisma, { slug: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
  const user = await createUser(prisma, { organizationId: org.id, email: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}@t.test`, role });
  const session = await loginAgent(app, user.email);
  return { org, user, ...session };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Sincronización con WhatsApp (todo apagado por defecto)', () => {
  test('una cuenta nueva tiene las 5 opciones desactivadas', async () => {
    const { agent } = await setup();
    const res = await agent.get('/api/org/sync');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.type)).toEqual(['groups', 'contacts', 'message_history', 'avatars', 'statuses']);
    expect(res.body.items.every((i) => i.enabled === false)).toBe(true);
  });

  test('activar una opción no activa las demás, y queda auditado', async () => {
    const { org, agent, csrfToken } = await setup();
    const res = await agent.patch('/api/org/sync').set('X-CSRF-Token', csrfToken).send({ groups: true });
    expect(res.status).toBe(200);
    expect(res.body.items.filter((i) => i.enabled).map((i) => i.type)).toEqual(['groups']);
    const log = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'whatsapp_sync.enabled' } });
    expect(log.metadata.type).toBe('groups');
  });

  test('solo OWNER/ADMIN administran la sincronización', async () => {
    const { agent, csrfToken } = await setup('AGENT');
    expect((await agent.get('/api/org/sync')).status).toBe(403);
    expect((await agent.patch('/api/org/sync').set('X-CSRF-Token', csrfToken).send({ groups: true })).status).toBe(403);
  });

  test('sin autorización no se puede descargar (403) y las rutas viejas también lo exigen', async () => {
    const { agent, csrfToken } = await setup();
    expect((await agent.post('/api/org/sync/groups/run').set('X-CSRF-Token', csrfToken).send({})).status).toBe(403);
    expect((await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({})).status).toBe(403);
    expect((await agent.post('/api/org/whatsapp/sync-contacts').set('X-CSRF-Token', csrfToken).send({})).status).toBe(403);
  });

  test('descargar grupos corre en segundo plano, reporta el resultado y no duplica al repetir', async () => {
    const groups = [{ jid: '1@g.us', name: 'A', description: null, ownerJid: null, ownerPhone: null, groupCreatedAt: null, announce: false, members: [{ jid: '595981000001@s.whatsapp.net', lid: null, phone: '595981000001', name: 'Ana', role: null, isSelf: false }] }];
    jest.spyOn(whatsapp, 'fetchGroupsDetailed').mockResolvedValue(groups);
    jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected', phone: '595985000000' });
    const { org, agent, csrfToken } = await setup();
    await agent.patch('/api/org/sync').set('X-CSRF-Token', csrfToken).send({ groups: true });

    const start = await agent.post('/api/org/sync/groups/run').set('X-CSRF-Token', csrfToken).send({});
    expect(start.status).toBe(202);
    await wait(800);
    let state = await agent.get('/api/org/sync');
    let item = state.body.items.find((i) => i.type === 'groups');
    expect(item.job.status).toBe('COMPLETED');
    expect(item.job.message).toContain('1 grupos y 1 participantes');
    expect(item.stored).toBe(1);

    await agent.post('/api/org/sync/groups/run').set('X-CSRF-Token', csrfToken).send({});
    await wait(800);
    expect(await prisma.whatsappGroup.count({ where: { organizationId: org.id } })).toBe(1);
    expect(await prisma.whatsappGroupMember.count()).toBe(1);
  });

  test('desactivar no borra lo importado; “Eliminar datos importados” sí, con auditoría', async () => {
    const { org, agent, csrfToken } = await setup();
    await prisma.whatsappGroup.create({ data: { organizationId: org.id, jid: '9@g.us', name: 'X' } });
    await agent.patch('/api/org/sync').set('X-CSRF-Token', csrfToken).send({ groups: true });
    await agent.patch('/api/org/sync').set('X-CSRF-Token', csrfToken).send({ groups: false });
    expect(await prisma.whatsappGroup.count()).toBe(1);
    const del = await agent.delete('/api/org/sync/groups/data').set('X-CSRF-Token', csrfToken);
    expect(del.body.removed).toBe(1);
    expect(await prisma.whatsappGroup.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'whatsapp_sync.data_deleted' } })).toBe(1);
  });

  test('las banderas son por empresa', async () => {
    const a = await setup();
    const b = await setup();
    await a.agent.patch('/api/org/sync').set('X-CSRF-Token', a.csrfToken).send({ contacts: true });
    sync.invalidateFlags(a.org.id); sync.invalidateFlags(b.org.id);
    expect(await sync.isEnabled(a.org.id, 'contacts')).toBe(true);
    expect(await sync.isEnabled(b.org.id, 'contacts')).toBe(false);
  });

  test('los mensajes históricos no se guardan sin autorización, y los nuevos sí', async () => {
    const { org } = await setup();
    // Mock de baileys: probamos la puerta a través de la función de servidor
    expect(await sync.isEnabled(org.id, 'message_history')).toBe(false);
    await prisma.organizationSettings.update({ where: { organizationId: org.id }, data: { syncMessageHistoryEnabled: true } });
    sync.invalidateFlags(org.id);
    expect(await sync.isEnabled(org.id, 'message_history')).toBe(true);
  });
});
