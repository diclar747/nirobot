const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

// Como WhatsApp: un contacto = un chat. Cerrarlo es un estado, no archivar y abrir otro hilo.
describe('Un solo chat por contacto', () => {
  const inbound = (text, id) => ({ key: { remoteJid: '595985768793@s.whatsapp.net', fromMe: false, id }, pushName: 'Cliente', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } });
  const sock = { profilePictureUrl: async () => null };

  test('un mensaje nuevo reabre el chat cerrado en vez de crear otro', async () => {
    const org = await createOrganization(prisma, { slug: 'single-thread' });
    await whatsapp.ingestMessages(org.id, sock, [inbound('Hola', 'm1')], false);
    const first = await prisma.conversation.findFirst({ where: { organizationId: org.id } });
    expect(first).not.toBeNull();

    await prisma.conversation.update({ where: { id: first.id }, data: { status: 'CLOSED', tags: ['Cerradas', 'Derivado'] } });

    await whatsapp.ingestMessages(org.id, sock, [inbound('Buenas, otra consulta', 'm2')], false);

    expect(await prisma.conversation.count({ where: { organizationId: org.id } })).toBe(1);
    const reopened = await prisma.conversation.findUnique({ where: { id: first.id } });
    expect(reopened.status).toBe('OPEN');
    // Sin agente asignado se quita "Derivado" para que el bot pueda volver a atender.
    expect(reopened.tags).not.toContain('Derivado');
    expect(await prisma.message.count({ where: { conversationId: first.id } })).toBe(2);
  });

  test('si el chat cerrado tenía agente, se reabre y sigue siendo suyo', async () => {
    const org = await createOrganization(prisma, { slug: 'single-thread-2' });
    const agent = await createUser(prisma, { organizationId: org.id, email: 'ana@thread.test', role: 'AGENT' });
    await whatsapp.ingestMessages(org.id, sock, [inbound('Hola', 'n1')], false);
    const conv = await prisma.conversation.findFirst({ where: { organizationId: org.id } });
    await prisma.conversation.update({ where: { id: conv.id }, data: { status: 'CLOSED', assignedToId: agent.id } });

    await whatsapp.ingestMessages(org.id, sock, [inbound('Hola de nuevo', 'n2')], false);
    const reopened = await prisma.conversation.findUnique({ where: { id: conv.id } });
    expect(await prisma.conversation.count({ where: { organizationId: org.id } })).toBe(1);
    expect(reopened.status).toBe('OPEN');
    expect(reopened.assignedToId).toBe(agent.id);
  });

  test('crear el chat desde el panel abre el existente aunque esté cerrado', async () => {
    const org = await createOrganization(prisma, { slug: 'single-thread-3' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@thread.test', role: 'OWNER' });
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981222333' } });
    const conv = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', status: 'CLOSED' } });
    const { agent: session, csrfToken } = await loginAgent(app, owner.email);

    const res = await session.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ contactId: contact.id, channel: 'whatsapp' });
    expect(res.status).toBe(200);
    expect(res.body.conversation.id).toBe(conv.id);
    expect(res.body.conversation.status).toBe('OPEN');
    expect(await prisma.conversation.count({ where: { organizationId: org.id } })).toBe(1);
  });
});
