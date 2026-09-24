const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const calls = require('../src/lib/callCampaigns');
const whatsapp = require('../src/lib/whatsapp');
const { registerInboundResponse } = require('../src/lib/callSurveys');

beforeEach(async () => { process.env.WHATSAPP_CALL_PROVIDER = 'mock'; await resetDb(); jest.restoreAllMocks(); });
afterAll(async () => { await calls.shutdown(); delete process.env.WHATSAPP_CALL_PROVIDER; await resetDb(); await prisma.$disconnect(); });

// Como en el menú del bot de WhatsApp: "opción 1 = Compras" tiene que derivar el chat al área, no solo etiquetarlo.
async function setup() {
  const org = await createOrganization(prisma, { slug: `sv-hoff-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner${Date.now()}@svhoff.test`, role: 'OWNER' });
  const ana = await createUser(prisma, { organizationId: org.id, email: `ana${Date.now()}@svhoff.test`, role: 'AGENT' });
  const compras = await prisma.department.create({ data: { organizationId: org.id, name: 'Compras' } });
  await prisma.departmentMember.create({ data: { departmentId: compras.id, userId: ana.id } });

  const account = await prisma.callAccount.create({ data: { organizationId: org.id, name: 'WA', sessionReference: 'mock', status: 'CONNECTED' } });
  const audio = await prisma.callAudio.create({ data: { organizationId: org.id, name: 'Promo', storageKey: 'x.mp3', mimeType: 'audio/mpeg', size: 1000 } });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000777', callConsentStatus: 'GRANTED' } });
  await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp' } });

  const session = await loginAgent(app, owner.email);
  const created = await session.agent.post('/api/org/wa-calls/campaigns').set('X-CSRF-Token', session.csrfToken).send({
    name: 'Con derivación', accountId: account.id, audioId: audio.id, contactIds: [contact.id],
    surveyEnabled: true, surveyQuestion: '¿Con qué área querés hablar?',
    surveyOptions: [
      { key: '1', label: 'Compras', action: 'NONE', departmentId: compras.id },
      { key: '2', label: 'Ventas', action: 'NONE' }
    ]
  });
  expect(created.status).toBe(201);
  await prisma.callCampaign.update({ where: { id: created.body.campaign.id }, data: { status: 'RUNNING' } });
  await prisma.callCampaignRecipient.updateMany({ where: { campaignId: created.body.campaign.id }, data: { status: 'COMPLETED' } });
  return { org, owner, ana, compras, contact, session };
}

describe('Encuesta de llamada: opción que deriva a un área o agente', () => {
  test('elegir "1" (Compras) deriva el chat al área: queda "Derivado" y la agente lo ve en su bandeja', async () => {
    const { org, ana, compras, contact } = await setup();
    jest.spyOn(whatsapp, 'sendText').mockResolvedValue('WA1');

    const result = await registerInboundResponse(org.id, contact.phone, '1');
    expect(result).not.toBeNull();

    const conversation = await prisma.conversation.findFirst({ where: { organizationId: org.id, contactId: contact.id } });
    expect(conversation.departmentId).toBe(compras.id);
    expect(conversation.tags).toContain('Derivado');
    expect(conversation.status).toBe('OPEN');

    // La nota de transferencia queda para que el equipo la vea (misma mecánica que el menú del bot).
    const notes = await prisma.message.findMany({ where: { conversationId: conversation.id, direction: 'NOTE' } });
    expect(notes.some((n) => n.content.includes('[TRANSFERENCIA]'))).toBe(true);

    const anaSession = await loginAgent(app, ana.email);
    const bandeja = await anaSession.agent.get('/api/org/conversations');
    expect(bandeja.body.conversations.map((c) => c.id)).toContain(conversation.id);
  });

  test('elegir "2" (Ventas, sin destino) no deriva: la conversación sigue sin área ni "Derivado"', async () => {
    const { org, contact } = await setup();
    jest.spyOn(whatsapp, 'sendText').mockResolvedValue('WA1');
    await registerInboundResponse(org.id, contact.phone, '2');
    const conversation = await prisma.conversation.findFirst({ where: { organizationId: org.id, contactId: contact.id } });
    expect(conversation.departmentId).toBeNull();
    expect(conversation.tags).not.toContain('Derivado');
  });

  test('crear una campaña con una opción que apunta a un área de otra empresa se rechaza', async () => {
    const orgB = await createOrganization(prisma, { slug: `sv-hoff-b-${Date.now()}` });
    const deptB = await prisma.department.create({ data: { organizationId: orgB.id, name: 'Ajena' } });
    const { session, org } = await setup();
    const account = await prisma.callAccount.findFirst({ where: { organizationId: org.id } });
    const audio = await prisma.callAudio.findFirst({ where: { organizationId: org.id } });
    const contact = await prisma.contact.findFirst({ where: { organizationId: org.id } });
    const res = await session.agent.post('/api/org/wa-calls/campaigns').set('X-CSRF-Token', session.csrfToken).send({
      name: 'Cruzada', accountId: account.id, audioId: audio.id, contactIds: [contact.id],
      surveyEnabled: true, surveyQuestion: '¿Área?',
      surveyOptions: [{ key: '1', label: 'X', departmentId: deptB.id }, { key: '2', label: 'Y' }]
    });
    expect(res.status).toBe(400);
  });

  test('la configuración de la campaña devuelve el área/agente elegidos, para poder editarlos', async () => {
    const { session, compras } = await setup();
    const campaign = await prisma.callCampaign.findFirst();
    const config = await session.agent.get(`/api/org/wa-calls/campaigns/${campaign.id}/config`);
    expect(config.status).toBe(200);
    const opcion1 = config.body.survey.options.find((o) => o.key === '1');
    expect(opcion1.departmentId).toBe(compras.id);
  });
});
