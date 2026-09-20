const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); });

async function setup() {
  const organization = await createOrganization(prisma, { slug: `cg-${Date.now()}` });
  const owner = await createUser(prisma, { organizationId: organization.id, email: `o${Date.now()}@cg.test`, role: 'OWNER' });
  const session = await loginAgent(app, owner.email);
  return { organization, ...session };
}

describe('Directorio de contactos', () => {
  test('lista paginada, exportación CSV, enviar a CRM y eliminar', async () => {
    const { organization, agent, csrfToken } = await setup();
    const ana = await prisma.contact.create({ data: { organizationId: organization.id, name: 'Ana', phone: '595981111111', tags: ['vip'] } });
    await prisma.contact.create({ data: { organizationId: organization.id, phone: '595982222222' } });

    const dir = await agent.get('/api/org/contacts/directory?limit=10');
    expect(dir.status).toBe(200);
    expect(dir.body.total).toBe(2);
    expect(dir.body.stats.withName).toBe(1);
    expect(dir.body.tags).toContain('vip');
    expect((await agent.get('/api/org/contacts/directory?tag=vip')).body.total).toBe(1);

    const csv = await agent.get('/api/org/contacts/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Ana');
    expect(csv.text).toContain('+595982222222');

    const crm = await agent.post(`/api/org/contacts/${ana.id}/crm`).set('X-CSRF-Token', csrfToken).send({ stage: 'Clientes' });
    expect(crm.status).toBe(200);
    const conv = await prisma.conversation.findFirst({ where: { contactId: ana.id } });
    expect(conv.tags).toContain('Clientes');
    expect((await agent.get('/api/org/contacts/directory?stage=Clientes')).body.total).toBe(1);
    expect((await agent.post(`/api/org/contacts/${ana.id}/crm`).set('X-CSRF-Token', csrfToken).send({ stage: 'Nada' })).status).toBe(400);

    expect((await agent.delete(`/api/org/contacts/${ana.id}`).set('X-CSRF-Token', csrfToken)).status).toBe(200);
    expect(await prisma.contact.count({ where: { organizationId: organization.id } })).toBe(1);
  });
});

describe('Campañas a grupos', () => {
  test('crea una campaña solo con grupos reales y rechaza grupos desconocidos', async () => {
    const { agent, csrfToken } = await setup();
    jest.spyOn(whatsapp, 'listGroups').mockResolvedValue([{ id: '1203630@g.us', name: 'Clientes VIP', size: 20, announce: false, canSend: true }]);
    const groups = await agent.get('/api/org/campaigns/groups');
    expect(groups.body.groups[0].name).toBe('Clientes VIP');

    const ok = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'A grupos', message: 'Hola {{nombre}}', groupJids: ['1203630@g.us'] });
    expect(ok.status).toBe(201);
    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: ok.body.campaign.id } });
    expect(recipients).toHaveLength(1);
    expect(recipients[0].groupJid).toBe('1203630@g.us');
    expect(recipients[0].contactId).toBeNull();
    const detail = await agent.get(`/api/org/campaigns/${ok.body.campaign.id}`);
    expect(detail.body.recipients[0].contact.isGroup).toBe(true);

    const bad = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'X', message: 'Hola', groupJids: ['9999@g.us'] });
    expect(bad.status).toBe(400);
  });

  test('el motor envía al JID del grupo y no crea conversación', async () => {
    const { organization, agent, csrfToken } = await setup();
    jest.spyOn(whatsapp, 'listGroups').mockResolvedValue([{ id: '1203630@g.us', name: 'Clientes VIP', size: 20, announce: false, canSend: true }]);
    jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected' });
    const sent = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('WAID1');
    const created = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'G', message: 'Hola {{nombre}}', groupJids: ['1203630@g.us'] });
    const { processNext } = require('../src/lib/campaigns');
    await prisma.campaign.update({ where: { id: created.body.campaign.id }, data: { status: 'SENDING' } });
    await processNext(organization.id, created.body.campaign.id);
    expect(sent).toHaveBeenCalledWith(organization.id, '1203630@g.us', 'Hola Clientes');
    expect(await prisma.conversation.count({ where: { organizationId: organization.id } })).toBe(0);
    require('../src/lib/campaigns').clearAllTimers();
  });
});
