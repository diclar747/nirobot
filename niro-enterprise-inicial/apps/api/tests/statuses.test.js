const fs = require('fs');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const statuses = require('../src/lib/whatsappStatus');
const { resolvePath } = require('../src/lib/storage');

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

const helpers = (over = {}) => ({
  extractMedia: () => null,
  extractText: (m) => m.message?.extendedTextMessage?.text || m.message?.conversation || null,
  downloadInboundMedia: async () => Buffer.from('imagen'),
  resolvePhoneJid: async (_s, jid) => jid,
  phoneFromJid: (jid) => String(jid).split('@')[0].split(':')[0],
  ...over
});
const sock = { user: { id: '595985768793:5@s.whatsapp.net' } };
const now = () => Math.floor(Date.now() / 1000);
const message = (id, body, extra = {}) => ({
  key: { remoteJid: 'status@broadcast', participant: '595981000222@s.whatsapp.net', id },
  messageTimestamp: now(), pushName: 'Ana', message: body, ...extra
});

async function setup() {
  const org = await createOrganization(prisma, { slug: 'stories' });
  const other = await createOrganization(prisma, { slug: 'stories-other' });
  const user = await createUser(prisma, { organizationId: org.id, email: 'a@stories.test', role: 'AGENT' });
  const otherUser = await createUser(prisma, { organizationId: other.id, email: 'b@stories.test', role: 'AGENT' });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana Pérez', phone: '595981000222', avatarUrl: 'https://x/ana.jpg' } });
  return { org, other, user, otherUser, contact };
}

describe('estados de WhatsApp', () => {
  test('guarda un estado de texto con su color y lo asocia al contacto', async () => {
    const { org, contact } = await setup();
    await statuses.handleStatusMessage(org.id, sock, message('S1', { extendedTextMessage: { text: 'Hola mundo', backgroundArgb: 0xff1a73e8 | 0 } }), helpers());
    const rows = await prisma.whatsappStatus.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'text', text: 'Hola mundo', contactId: contact.id, backgroundColor: '#1a73e8', fromMe: false });
    expect(rows[0].expiresAt.getTime() - rows[0].postedAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  test('guarda la imagen en disco y no duplica un mensaje repetido', async () => {
    const { org } = await setup();
    const img = helpers({ extractMedia: () => ({ kind: 'image', mimeType: 'image/jpeg' }), extractText: () => 'con pie' });
    const msg = message('S2', { imageMessage: {} });
    await statuses.handleStatusMessage(org.id, sock, msg, img);
    await statuses.handleStatusMessage(org.id, sock, msg, img);
    const rows = await prisma.whatsappStatus.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'image', caption: 'con pie', mimeType: 'image/jpeg' });
    expect(fs.existsSync(resolvePath(rows[0].storageKey))).toBe(true);
  });

  test('ignora estados que ya vencieron y mensajes que no son estados', async () => {
    const { org } = await setup();
    const old = message('S3', { conversation: 'viejo' }, { messageTimestamp: now() - 25 * 3600 });
    await statuses.handleStatusMessage(org.id, sock, old, helpers());
    const chat = { key: { remoteJid: '595981000222@s.whatsapp.net', id: 'C1' }, message: { conversation: 'hola' } };
    expect(await statuses.handleStatusMessage(org.id, sock, chat, helpers())).toBe(false);
    expect(await prisma.whatsappStatus.count()).toBe(0);
  });

  test('un estado eliminado por su autor desaparece', async () => {
    const { org } = await setup();
    await statuses.handleStatusMessage(org.id, sock, message('S4', { conversation: 'borrame' }), helpers());
    const revoke = message('R4', { protocolMessage: { type: 0, key: { id: 'S4' } } });
    await statuses.handleStatusMessage(org.id, sock, revoke, helpers());
    expect(await prisma.whatsappStatus.count()).toBe(0);
  });

  test('la API agrupa por contacto, aísla organizaciones y sirve el archivo solo a la propia', async () => {
    const { org, user, otherUser } = await setup();
    const img = helpers({ extractMedia: () => ({ kind: 'image', mimeType: 'image/png' }), extractText: () => null });
    await statuses.handleStatusMessage(org.id, sock, message('S5', { imageMessage: {} }), img);
    await statuses.handleStatusMessage(org.id, sock, message('S6', { conversation: 'segundo' }), helpers());

    const mine = await loginAgent(app, user.email);
    const list = await mine.agent.get('/api/org/statuses');
    expect(list.status).toBe(200);
    expect(list.body.groups).toHaveLength(1);
    expect(list.body.groups[0]).toMatchObject({ name: 'Ana Pérez', avatarUrl: 'https://x/ana.jpg' });
    expect(list.body.groups[0].items.map((i) => i.kind)).toEqual(['image', 'text']);

    const mediaUrl = list.body.groups[0].items[0].mediaUrl;
    const ok = await mine.agent.get(mediaUrl);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/image\/png/);

    const theirs = await loginAgent(app, otherUser.email);
    expect((await theirs.agent.get('/api/org/statuses')).body.groups).toHaveLength(0);
    expect((await theirs.agent.get(mediaUrl)).status).toBe(404);
  });

  test('la limpieza borra los vencidos y sus archivos', async () => {
    const { org } = await setup();
    const img = helpers({ extractMedia: () => ({ kind: 'image', mimeType: 'image/jpeg' }), extractText: () => null });
    await statuses.handleStatusMessage(org.id, sock, message('S7', { imageMessage: {} }), img);
    const row = await prisma.whatsappStatus.findFirst();
    await prisma.whatsappStatus.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await statuses.cleanupExpired()).toBe(1);
    expect(await prisma.whatsappStatus.count()).toBe(0);
    expect(fs.existsSync(resolvePath(row.storageKey))).toBe(false);
  });

  test('sin sesión no se puede listar (401)', async () => {
    const res = await require('supertest')(app).get('/api/org/statuses');
    expect(res.status).toBe(401);
  });
});
