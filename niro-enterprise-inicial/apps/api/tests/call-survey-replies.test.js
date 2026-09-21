const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const calls = require('../src/lib/callCampaigns');
const whatsapp = require('../src/lib/whatsapp');
const { registerInboundResponse, DEFAULT_REPLIES } = require('../src/lib/callSurveys');

beforeEach(async () => { process.env.WHATSAPP_CALL_PROVIDER = 'mock'; await resetDb(); jest.restoreAllMocks(); });
afterAll(async () => { await calls.shutdown(); delete process.env.WHATSAPP_CALL_PROVIDER; await resetDb(); await prisma.$disconnect(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `sv-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@sv.test`, role: 'OWNER' });
  const account = await prisma.callAccount.create({ data: { organizationId: org.id, name: 'WA', sessionReference: 'mock', status: 'CONNECTED' } });
  const audio = await prisma.callAudio.create({ data: { organizationId: org.id, name: 'Promo', storageKey: 'x.mp3', mimeType: 'audio/mpeg', size: 1000 } });
  const contacts = {};
  for (const [k, phone] of [['interesado', '595981000001'], ['no', '595981000002'], ['luego', '595981000003']]) {
    contacts[k] = await prisma.contact.create({ data: { organizationId: org.id, name: k, phone, callConsentStatus: 'GRANTED' } });
    await prisma.conversation.create({ data: { organizationId: org.id, contactId: contacts[k].id, channel: 'whatsapp' } });
  }
  const session = await loginAgent(app, owner.email);
  const created = await session.agent.post('/api/org/wa-calls/campaigns').set('X-CSRF-Token', session.csrfToken).send({
    name: 'Encuesta', accountId: account.id, audioId: audio.id, contactIds: Object.values(contacts).map((c) => c.id),
    surveyEnabled: true, surveyQuestion: '¿Desea recibir más información?',
    surveyOptions: [
      { key: '1', label: 'Sí, deseo información', action: 'INTERESTED', replyMessage: '¡Gracias! Te mantendremos informado.' },
      { key: '2', label: 'No, gracias', action: 'OPT_OUT' },
      { key: '3', label: 'Contactarme más adelante', action: 'FOLLOW_UP', replyMessage: 'Te contactaremos más adelante, gracias por tu interés.' }
    ]
  });
  expect(created.status).toBe(201);
  await prisma.callCampaign.update({ where: { id: created.body.campaign.id }, data: { status: 'RUNNING' } });
  await prisma.callCampaignRecipient.updateMany({ where: { campaignId: created.body.campaign.id }, data: { status: 'COMPLETED' } });
  return { org, contacts, session, campaignId: created.body.campaign.id };
}

describe('Encuesta posterior a la llamada: respuestas automáticas', () => {
  test('cada opción guarda la respuesta, aplica su acción y contesta el texto configurado', async () => {
    const { org, contacts } = await setup();
    const sent = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('WA1');

    const r1 = await registerInboundResponse(org.id, '595981000001', '1');
    expect(r1.responseValue).toBe('1');
    expect(sent).toHaveBeenLastCalledWith(org.id, '595981000001', '¡Gracias! Te mantendremos informado.');
    const interesado = await prisma.contact.findUnique({ where: { id: contacts.interesado.id } });
    expect(interesado.tags).toContain('interesado');
    expect((await prisma.conversation.findFirst({ where: { contactId: contacts.interesado.id } })).tags).toContain('Interesados');

    const r2 = await registerInboundResponse(org.id, '595981000002', ' 2. ');
    expect(r2.responseValue).toBe('2');
    expect(sent).toHaveBeenLastCalledWith(org.id, '595981000002', DEFAULT_REPLIES.OPT_OUT); // sin texto propio: usa el de por defecto
    const no = await prisma.contact.findUnique({ where: { id: contacts.no.id } });
    expect(no.callOptedOutAt).toBeTruthy(); // no vuelve a recibir llamadas
    expect(no.callOptOutSource).toContain('No, gracias');

    await registerInboundResponse(org.id, '595981000003', '3');
    expect(sent).toHaveBeenLastCalledWith(org.id, '595981000003', 'Te contactaremos más adelante, gracias por tu interés.');
    expect((await prisma.contact.findUnique({ where: { id: contacts.luego.id } })).tags).toContain('contactar-mas-adelante');

    // la respuesta queda también en el chat del contacto, como mensaje del bot
    const chat = await prisma.message.findMany({ where: { conversation: { contactId: contacts.interesado.id }, direction: 'OUTBOUND' } });
    expect(chat.map((m) => m.content)).toContain('¡Gracias! Te mantendremos informado.');
    expect(chat[0].senderKind).toBe('bot');
  });

  test('responder dos veces no genera dos respuestas; un texto que no es opción se ignora', async () => {
    const { org } = await setup();
    const sent = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('WA1');
    await registerInboundResponse(org.id, '595981000001', '1');
    const again = await registerInboundResponse(org.id, '595981000001', '1');
    expect(again.duplicate).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(await registerInboundResponse(org.id, '595981000002', 'hola qué tal')).toBeNull();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  test('si WhatsApp falla al contestar, la respuesta igual queda registrada', async () => {
    const { org, contacts } = await setup();
    jest.spyOn(whatsapp, 'sendText').mockRejectedValue(new Error('sin conexión'));
    const r = await registerInboundResponse(org.id, '595981000002', '2');
    expect(r.responseValue).toBe('2');
    expect((await prisma.contact.findUnique({ where: { id: contacts.no.id } })).callOptedOutAt).toBeTruthy();
  });

  test('campañas anteriores (acción AUTO) se interpretan por el texto de la opción', async () => {
    const { org, contacts, campaignId } = await setup();
    await prisma.callSurveyOption.updateMany({ where: { survey: { campaignId } }, data: { action: 'AUTO', replyMessage: null } });
    const sent = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('WA1');
    await registerInboundResponse(org.id, '595981000002', '2'); // "No, gracias"
    expect((await prisma.contact.findUnique({ where: { id: contacts.no.id } })).callOptedOutAt).toBeTruthy();
    expect(sent).toHaveBeenLastCalledWith(org.id, '595981000002', DEFAULT_REPLIES.OPT_OUT);
    await registerInboundResponse(org.id, '595981000001', '1'); // "Sí, deseo información"
    expect(sent).toHaveBeenLastCalledWith(org.id, '595981000001', DEFAULT_REPLIES.INTERESTED);
  });

  test('sugerencias: acciones y textos por defecto según el sentido de cada opción', async () => {
    const { session } = await setup();
    const res = await session.agent.post('/api/org/wa-calls/survey/suggest-replies').set('X-CSRF-Token', session.csrfToken).send({
      question: '¿Desea recibir más información?',
      options: [{ key: '1', label: 'Sí, deseo información' }, { key: '2', label: 'No, gracias' }, { key: '3', label: 'Contactarme más adelante' }, { key: '4', label: 'Otra cosa' }]
    });
    expect(res.status).toBe(200);
    expect(res.body.replies.map((r) => r.action)).toEqual(['INTERESTED', 'OPT_OUT', 'FOLLOW_UP', 'NONE']);
    expect(res.body.replies[1].replyMessage).toMatch(/no vas a recibir más llamadas/i);
    expect((await session.agent.post('/api/org/wa-calls/survey/suggest-replies').set('X-CSRF-Token', session.csrfToken).send({ options: [] })).status).toBe(400);
  });
});
