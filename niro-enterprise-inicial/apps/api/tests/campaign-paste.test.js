const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const campaigns = require('../src/lib/campaigns');
const whatsapp = require('../src/lib/whatsapp');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

async function setup() {
  const organization = await createOrganization(prisma, { slug: 'campaign-paste' });
  const owner = await createUser(prisma, { organizationId: organization.id, email: 'owner@paste.test', role: 'OWNER' });
  const existing = await prisma.contact.create({ data: { organizationId: organization.id, name: 'Nombre Viejo', phone: '595985768793' } });
  const unnamed = await prisma.contact.create({ data: { organizationId: organization.id, name: '.', phone: '595981111222' } });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { agent, csrfToken, organization, existing, unnamed };
}

describe('Campañas: lista de números pegada', () => {
  test('lee número, nombre / nombre, número / solo número y normaliza a 595…', async () => {
    const { agent, csrfToken } = await setup();
    const text = '595985768793, Claudio\n0985768794, Juna\n985768795, Carlos\nPedro, 0981 222 333\n0985768796\n985758745\n0985768793\nhola\n12345';
    const res = await agent.post('/api/org/campaigns/parse-list').set('X-CSRF-Token', csrfToken).send({ text });
    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([
      { phone: '595985768793', name: 'Claudio' },
      { phone: '595985768794', name: 'Juna' },
      { phone: '595985768795', name: 'Carlos' },
      { phone: '595981222333', name: 'Pedro' },
      { phone: '595985768796', name: null },
      { phone: '595985758745', name: null }
    ]);
    expect(res.body.summary).toMatchObject({ valid: 6, duplicates: 1, invalid: 2 });
  });

  test('acepta números internacionales completos para WhatsApp', async () => {
    const { agent, csrfToken } = await setup();
    const res = await agent.post('/api/org/campaigns/parse-list').set('X-CSRF-Token', csrfToken).send({ text: '+54 9 11 5555 4444, Lucía' });
    expect(res.body.recipients).toEqual([{ phone: '5491155554444', name: 'Lucía' }]);
  });

  test('crea la campaña con la lista: crea contactos nuevos, completa nombres y personaliza con el nombre pegado', async () => {
    const { agent, csrfToken, organization, existing, unnamed } = await setup();
    const res = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({
      name: 'Lista pegada',
      message: 'Hola {{nombre}}!',
      manualRecipients: [
        { phone: '595985768793', name: 'Claudio' },
        { phone: '0981111222', name: 'Juana' },
        { phone: '985768795', name: 'Carlos' },
        { phone: '0985768796', name: null },
        { phone: '0985768795', name: null }
      ]
    });
    expect(res.status).toBe(201);
    expect(res.body.campaign.counts.total).toBe(4);

    const created = await prisma.contact.findMany({ where: { organizationId: organization.id }, orderBy: { phone: 'asc' } });
    expect(created.map((c) => [c.phone, c.name])).toEqual([
      ['595981111222', 'Juana'],
      ['595985768793', 'Nombre Viejo'],
      ['595985768795', 'Carlos'],
      ['595985768796', null]
    ]);
    void unnamed;

    const sent = [];
    jest.spyOn(whatsapp, 'sendText').mockImplementation(async (_org, to, text) => { sent.push([to, text]); return `wa-${sent.length}`; });
    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: res.body.campaign.id }, include: { contact: true } });
    const rendered = recipients.map((r) => campaigns.personalizeCampaignMessage('Hola {{nombre}}!', { ...r.contact, name: r.displayName || r.contact.name }));
    expect(rendered.sort()).toEqual(['Hola Carlos!', 'Hola Claudio!', 'Hola Juana!', 'Hola cliente!']);

    const detail = await agent.get(`/api/org/campaigns/${res.body.campaign.id}`);
    expect(detail.body.recipients.find((r) => r.contact.id === existing.id).contact.name).toBe('Claudio');

    const config = await agent.get(`/api/org/campaigns/${res.body.campaign.id}/config`);
    expect(config.body.manualRecipients).toEqual(expect.arrayContaining([{ phone: '595985768793', name: 'Claudio' }, { phone: '595981111222', name: 'Juana' }]));
    expect(config.body.contactIds).toHaveLength(1);
  });

  test('combina lista pegada con contactos del CRM sin repetir', async () => {
    const { agent, csrfToken, existing } = await setup();
    const res = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({
      name: 'Mixta', message: 'Hola', contactIds: [existing.id], manualRecipients: [{ phone: '0985768793', name: 'Claudio' }, { phone: '0985000111' }]
    });
    expect(res.status).toBe(201);
    expect(res.body.campaign.counts.total).toBe(2);
  });

  test('rechaza una lista sin ningún número válido', async () => {
    const { agent, csrfToken } = await setup();
    const res = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'Mala', message: 'Hola', manualRecipients: [{ phone: '123456', name: 'X' }] });
    expect(res.status).toBe(400);
  });
});
