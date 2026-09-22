const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); });

const SAMPLE = [
  { jid: '1203@g.us', name: 'Ventas', description: 'Equipo', ownerJid: '595981000001@s.whatsapp.net', ownerPhone: '595981000001', groupCreatedAt: new Date('2025-01-01'), announce: false,
    members: [
      { jid: '595981000001@s.whatsapp.net', lid: null, phone: '595981000001', name: 'Ana', role: 'superadmin', isSelf: false },
      { jid: '37555378630815@lid', lid: '37555378630815@lid', phone: null, name: null, role: null, isSelf: false },
      { jid: '595981000003@s.whatsapp.net', lid: null, phone: '595981000003', name: 'Luis', role: 'admin', isSelf: false }
    ] },
  { jid: '1204@g.us', name: 'Soporte', description: null, ownerJid: null, ownerPhone: null, groupCreatedAt: null, announce: true,
    members: [{ jid: '595981000001@s.whatsapp.net', lid: null, phone: '595981000001', name: 'Ana', role: null, isSelf: false }] }
];

async function setup() {
  const org = await createOrganization(prisma, { slug: `g-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
  await prisma.organizationSettings.update({ where: { organizationId: org.id }, data: { syncGroupsEnabled: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `g${Date.now()}@t.test`, role: 'OWNER' });
  const session = await loginAgent(app, owner.email);
  return { org, ...session };
}

describe('Grupos de WhatsApp', () => {
  test('sincroniza, lista con resumen, muestra integrantes y no inventa teléfonos para los LID', async () => {
    jest.spyOn(whatsapp, 'fetchGroupsDetailed').mockResolvedValue(SAMPLE);
    const { agent, csrfToken } = await setup();

    const sync = await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({});
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ groups: 2, members: 4 });

    const list = await agent.get('/api/org/groups');
    expect(list.body.stats).toMatchObject({ groups: 2, memberships: 4, uniqueMembers: 2, admins: 2, unidentified: 1 });
    const ventas = list.body.groups.find((g) => g.name === 'Ventas');
    expect(ventas).toMatchObject({ memberCount: 3, admins: 2, unidentified: 1 });

    const detail = await agent.get(`/api/org/groups/${ventas.id}/members`);
    expect(detail.body.members[0].role).toBe('superadmin');
    const pending = detail.body.members.find((m) => m.lid);
    expect(pending.phone).toBeNull();
    expect(pending.phoneKnown).toBe(false);

    const search = await agent.get('/api/org/groups?q=soporte');
    expect(search.body.groups.map((g) => g.name)).toEqual(['Soporte']);
  });

  test('una nueva sincronización reemplaza integrantes y elimina grupos que ya no existen', async () => {
    const spy = jest.spyOn(whatsapp, 'fetchGroupsDetailed').mockResolvedValue(SAMPLE);
    const { agent, csrfToken } = await setup();
    await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({});
    spy.mockResolvedValue([SAMPLE[1]]);
    await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({});
    const list = await agent.get('/api/org/groups');
    expect(list.body.groups.map((g) => g.name)).toEqual(['Soporte']);
    expect(await prisma.whatsappGroupMember.count()).toBe(1);
  });

  test('exporta CSV de grupos e integrantes (con "pendiente de identificar")', async () => {
    jest.spyOn(whatsapp, 'fetchGroupsDetailed').mockResolvedValue(SAMPLE);
    const { agent, csrfToken } = await setup();
    await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({});

    const members = await agent.get('/api/org/groups/export.csv?scope=members');
    expect(members.headers['content-type']).toContain('text/csv');
    expect(members.text).toContain('Ventas,Ana,+595981000001,Creador,Identificado');
    expect(members.text).toContain('Pendiente de identificar');
    const onlyPhones = await agent.get('/api/org/groups/export.csv?scope=members&onlyWithPhone=1');
    expect(onlyPhones.text).not.toContain('Pendiente');

    const groups = await agent.get('/api/org/groups/export.csv?scope=groups');
    expect(groups.text).toContain('Ventas,1203@g.us,3');
  });

  test('sin WhatsApp conectado la sincronización responde 409 y hay que tener el permiso', async () => {
    const { org, agent, csrfToken } = await setup();
    const res = await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({});
    expect(res.status).toBe(409);

    const limited = await createUser(prisma, { organizationId: org.id, email: `lim${Date.now()}@t.test`, role: 'AGENT' });
    await prisma.user.update({ where: { id: limited.id }, data: { permissions: { groups: false } } });
    const other = await loginAgent(app, limited.email);
    expect((await other.agent.get('/api/org/groups')).status).toBe(403);
  });

  test('resuelve el nombre con un contacto que Niro ya conoce, aunque WhatsApp no lo entregue', async () => {
    const noNameSample = [{ ...SAMPLE[0], members: [{ jid: '595981000009@s.whatsapp.net', lid: null, phone: '595981000009', name: null, role: null, isSelf: false }] }];
    jest.spyOn(whatsapp, 'fetchGroupsDetailed').mockResolvedValue(noNameSample);
    const { org, agent, csrfToken } = await setup();
    await prisma.contact.create({ data: { organizationId: org.id, phone: '595981000009', name: 'Rosa Conocida' } });
    await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({});
    const detail = await agent.get(`/api/org/groups/${(await agent.get('/api/org/groups')).body.groups[0].id}/members`);
    expect(detail.body.members[0].name).toBe('Rosa Conocida');
  });

  test('re-sincronizar no borra los avatares de grupo/integrante ya descargados', async () => {
    jest.spyOn(whatsapp, 'fetchGroupsDetailed').mockResolvedValue(SAMPLE);
    const { org, agent, csrfToken } = await setup();
    await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({});
    const group = await prisma.whatsappGroup.findFirst({ where: { name: 'Ventas' } });
    // avatarUrl guarda la storageKey ("orgId/archivo") de la foto ya bajada, nunca el link crudo de WhatsApp.
    const groupKey = `${org.id}/grupo.jpg`;
    const memberKey = `${org.id}/ana.jpg`;
    await prisma.whatsappGroup.update({ where: { id: group.id }, data: { avatarUrl: groupKey } });
    const member = await prisma.whatsappGroupMember.findFirst({ where: { groupId: group.id, phone: '595981000001' } });
    await prisma.whatsappGroupMember.update({ where: { id: member.id }, data: { avatarUrl: memberKey } });

    await agent.post('/api/org/groups/sync').set('X-CSRF-Token', csrfToken).send({});
    expect((await prisma.whatsappGroup.findUnique({ where: { id: group.id } })).avatarUrl).toBe(groupKey);
    expect((await prisma.whatsappGroupMember.findUnique({ where: { id: member.id } })).avatarUrl).toBe(memberKey);

    const list = await agent.get('/api/org/groups');
    expect(list.body.groups.find((g) => g.name === 'Ventas').avatarUrl).toBe(`/api/org/groups/avatar/${groupKey}`);
  });
});
