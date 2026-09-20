const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { personalizeCampaignMessage: p, findUnknownVariables } = require('../src/lib/campaignVariables');
const campaigns = require('../src/lib/campaigns');
const whatsapp = require('../src/lib/whatsapp');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); });

describe('Variables de personalización', () => {
  const ana = { name: 'Ana María Paz', phone: '595981000001', email: 'ana@mail.com' };

  test('reemplaza nombre, nombre completo, teléfono y email (con espacios y mayúsculas)', () => {
    expect(p('Hola {{nombre}} ({{ Nombre_Completo }}) · {{telefono}} · {{EMAIL}}', ana)).toBe('Hola Ana (Ana María Paz) · 595981000001 · ana@mail.com');
  });

  test('sin dato: nombre→"cliente", email/teléfono en blanco (nunca "—") y respaldo con |', () => {
    expect(p('Hola {{nombre}}!', { phone: '1' })).toBe('Hola cliente!');
    expect(p('Tu mail: {{email}}.', { name: 'Ana', phone: '1' })).toBe('Tu mail:.');
    expect(p('Hola {{nombre|amigo}}, {{email|sin email}}', { phone: '1' })).toBe('Hola amigo, sin email');
    expect(p('Hola {{nombre|amigo}}', ana)).toBe('Hola Ana');
    expect(p('x {{email}} y', { name: 'Ana' })).not.toContain('—');
  });

  test('detecta variables desconocidas', () => {
    expect(findUnknownVariables('{{nombre}} {{nombr}} {{ foo|x }}')).toEqual(['{{nombr}}', '{{foo}}']);
    expect(findUnknownVariables('{{nombre}} {{email|x}} {{telefono}}')).toEqual([]);
  });
});

describe('Crear y enviar una campaña personalizada', () => {
  async function setup() {
    const org = await createOrganization(prisma, { slug: `pz-${Date.now()}` });
    const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@pz.test`, role: 'OWNER' });
    const session = await loginAgent(app, owner.email);
    return { org, ...session };
  }

  test('rechaza una variable mal escrita con un 400 claro', async () => {
    const { agent, csrfToken, org } = await setup();
    const c = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana', phone: '595981000001' } });
    const res = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'X', message: 'Hola {{nombr}}', contactIds: [c.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\{\{nombr\}\}/);
  });

  test('cada destinatario recibe su mensaje con sus propios datos', async () => {
    const { agent, csrfToken, org } = await setup();
    const ana = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana Paz', phone: '595981000001', email: 'ana@mail.com' } });
    const sin = await prisma.contact.create({ data: { organizationId: org.id, phone: '595981000002' } });
    const sent = jest.spyOn(whatsapp, 'sendText').mockImplementation(async (_o, phone) => `wa-${phone}`);
    jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected' });
    const created = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'P', message: 'Hola {{nombre|amigo}}, tu mail: {{email|no cargado}}', contactIds: [ana.id, sin.id], messagesPerHour: 100 });
    expect(created.status).toBe(201);
    await prisma.campaign.update({ where: { id: created.body.campaign.id }, data: { status: 'SENDING' } });
    await campaigns.processNext(org.id, created.body.campaign.id);
    await campaigns.processNext(org.id, created.body.campaign.id);
    campaigns.clearAllTimers();
    const texts = Object.fromEntries(sent.mock.calls.map(([, phone, text]) => [phone, text]));
    expect(texts['595981000001']).toBe('Hola Ana, tu mail: ana@mail.com');
    expect(texts['595981000002']).toBe('Hola amigo, tu mail: no cargado');
  });
});
