const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `ga-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  await createUser(prisma, { organizationId: org.id, email: `ga${Date.now()}${Math.random().toString(36).slice(2, 6)}@t.test`, role: 'OWNER' });
  return { org };
}

// El link que da `profilePictureUrl` vence a las pocas horas — se descarga la imagen y se guarda
// en disco (storageKey "orgId/archivo"), nunca el link crudo. Estos tests simulan esa descarga.
function mockImageFetch() {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => Buffer.from('fake-jpeg-bytes')
  });
}

describe('Avatares de grupos e integrantes', () => {
  test('descarga la foto del grupo y de cada integrante, y reutiliza la del contacto si ya la tiene', async () => {
    const { org } = await setup();
    const group = await prisma.whatsappGroup.create({ data: { organizationId: org.id, jid: '1@g.us', name: 'Ventas' } });
    await prisma.whatsappGroupMember.createMany({
      data: [
        { groupId: group.id, jid: '595981000001@s.whatsapp.net', phone: '595981000001', name: 'Ana' },
        { groupId: group.id, jid: '595981000002@s.whatsapp.net', phone: '595981000002', name: 'Luis' }
      ]
    });
    // Ana ya tiene foto guardada como Contact (por ejemplo, la trajo la sincronización de contactos): no hay que pedirla de nuevo.
    await prisma.contact.create({ data: { organizationId: org.id, phone: '595981000001', name: 'Ana', avatarUrl: `${org.id}/ana-ya-conocida.jpg` } });

    const fetchMock = mockImageFetch();
    const sock = { profilePictureUrl: jest.fn().mockResolvedValue('https://cdn/foto.jpg') };
    const result = await whatsapp.backfillGroupAvatarsWithSock(org.id, sock);

    expect(result).toMatchObject({ started: true, fetched: 3, processed: 3 }); // grupo + Ana (reutilizada) + Luis
    const savedGroup = await prisma.whatsappGroup.findUnique({ where: { id: group.id } });
    expect(savedGroup.avatarUrl).toMatch(new RegExp(`^${org.id}/`));
    const ana = await prisma.whatsappGroupMember.findFirst({ where: { groupId: group.id, phone: '595981000001' } });
    const luis = await prisma.whatsappGroupMember.findFirst({ where: { groupId: group.id, phone: '595981000002' } });
    expect(ana.avatarUrl).toBe(`${org.id}/ana-ya-conocida.jpg`);
    expect(luis.avatarUrl).toMatch(new RegExp(`^${org.id}/`));
    // La foto de Ana vino del Contact ya conocido: nunca se llamó a WhatsApp con su número.
    expect(sock.profilePictureUrl).not.toHaveBeenCalledWith(expect.stringContaining('595981000001'), expect.anything());
    // Se pidió la del grupo y la de Luis (no la de Ana), y se descargó cada una (nunca el link crudo).
    expect(sock.profilePictureUrl).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('si WhatsApp no tiene la foto (o está privada) queda "sin foto" y no se vuelve a pedir en la próxima corrida', async () => {
    const { org } = await setup();
    const group = await prisma.whatsappGroup.create({ data: { organizationId: org.id, jid: '2@g.us', name: 'Soporte' } });
    const sock = { profilePictureUrl: jest.fn().mockRejectedValue(new Error('item-not-found')) };
    await whatsapp.backfillGroupAvatarsWithSock(org.id, sock);
    expect((await prisma.whatsappGroup.findUnique({ where: { id: group.id } })).avatarUrl).toBe('');

    await whatsapp.backfillGroupAvatarsWithSock(org.id, sock);
    expect(sock.profilePictureUrl).toHaveBeenCalledTimes(1); // no vuelve a pedirla: ya está marcada como "sin foto" (avatarUrl no es null)
  });

  test('se detiene si la sesión se desconecta a mitad de camino, sin perder lo ya descargado', async () => {
    const { org } = await setup();
    await prisma.whatsappGroup.createMany({ data: [{ organizationId: org.id, jid: '3@g.us', name: 'A' }, { organizationId: org.id, jid: '4@g.us', name: 'B' }] });
    mockImageFetch();
    const sock = { profilePictureUrl: jest.fn().mockResolvedValue('https://cdn/foto.jpg') };
    let calls = 0;
    const result = await whatsapp.backfillGroupAvatarsWithSock(org.id, sock, { stillConnected: () => (calls++ === 0) });
    expect(result.interrupted).toBe(true);
    expect(result.processed).toBe(1);
  });
});
