const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const niroAi = require('../src/lib/niroAi');
const { autoTranscribeIfEnabled } = require('../src/lib/aiMedia');
const billing = require('../src/lib/billing');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); billing.clearBlockedCache(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `tr-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@tr.test`, role: 'OWNER' });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana', phone: '595981000001' } });
  const conv = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp' } });
  const message = await prisma.message.create({ data: { conversationId: conv.id, direction: 'INBOUND', content: '🎤 Audio', contentType: 'audio' } });
  return { org, conv, message, session: await loginAgent(app, owner.email) };
}
const args = (s) => ({ organizationId: s.org.id, conversationId: s.conv.id, messageId: s.message.id, buffer: Buffer.from('audio'), fileName: 'nota.ogg', mimeType: 'audio/ogg' });

describe('Transcripción automática de audios', () => {
  test('la opción se activa en Configuración y se ve en los ajustes', async () => {
    const s = await setup();
    let org = await s.session.agent.get('/api/org');
    expect(org.body.organization.settings.autoTranscribeAudio).toBe(false);
    const res = await s.session.agent.patch('/api/org/settings').set('X-CSRF-Token', s.session.csrfToken).send({ autoTranscribeAudio: true });
    expect(res.status).toBe(200);
    expect(res.body.settings.autoTranscribeAudio).toBe(true);
    org = await s.session.agent.get('/api/org');
    expect(org.body.organization.settings.autoTranscribeAudio).toBe(true);
  });

  test('con la opción activa transcribe y guarda el texto en el mensaje', async () => {
    const s = await setup();
    await prisma.organizationSettings.update({ where: { organizationId: s.org.id }, data: { autoTranscribeAudio: true } });
    jest.spyOn(niroAi, 'isConfigured').mockReturnValue(true);
    const spy = jest.spyOn(niroAi, 'transcribeAudio').mockResolvedValue({ text: 'Hola, quisiera saber el precio del producto', cost: 0.01 });
    const text = await autoTranscribeIfEnabled(args(s));
    expect(text).toBe('Hola, quisiera saber el precio del producto');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await prisma.message.findUnique({ where: { id: s.message.id } })).transcription).toBe('Hola, quisiera saber el precio del producto');
    const detail = await s.session.agent.get(`/api/org/conversations/${s.conv.id}`); // y el chat lo devuelve
    expect(detail.body.messages[0].transcription).toBe('Hola, quisiera saber el precio del producto');
  });

  test('con la opción apagada, sin IA configurada o con plan vencido no transcribe (ni gasta IA)', async () => {
    const s = await setup();
    const spy = jest.spyOn(niroAi, 'transcribeAudio').mockResolvedValue({ text: 'x', cost: 0 });
    jest.spyOn(niroAi, 'isConfigured').mockReturnValue(true);
    expect(await autoTranscribeIfEnabled(args(s))).toBeNull();                       // opción apagada
    await prisma.organizationSettings.update({ where: { organizationId: s.org.id }, data: { autoTranscribeAudio: true } });
    niroAi.isConfigured.mockReturnValue(false);
    expect(await autoTranscribeIfEnabled(args(s))).toBeNull();                       // sin API de Niro IA
    niroAi.isConfigured.mockReturnValue(true);
    await prisma.organization.update({ where: { id: s.org.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    billing.clearBlockedCache();
    expect(await autoTranscribeIfEnabled(args(s))).toBeNull();                       // plan vencido
    expect(spy).not.toHaveBeenCalled();
  });

  test('si la IA falla, no rompe nada y el audio queda sin texto', async () => {
    const s = await setup();
    await prisma.organizationSettings.update({ where: { organizationId: s.org.id }, data: { autoTranscribeAudio: true } });
    jest.spyOn(niroAi, 'isConfigured').mockReturnValue(true);
    jest.spyOn(niroAi, 'transcribeAudio').mockRejectedValue(new Error('Niro IA caída'));
    expect(await autoTranscribeIfEnabled(args(s))).toBeNull();
    expect((await prisma.message.findUnique({ where: { id: s.message.id } })).transcription).toBeNull();
  });
});
