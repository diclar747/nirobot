const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');

beforeEach(async () => {
  await resetDb();
  jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected', qr: null, phone: '595980000000' });
  jest.spyOn(whatsapp, 'sendStatusBroadcast').mockResolvedValue('WA-STATUS-API');
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

// Imagen PNG mínima válida.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

async function setup(suffix = '') {
  const org = await createOrganization(prisma, { slug: `api-status${suffix}` });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner${suffix}@apistatus.test`, role: 'OWNER' });
  await prisma.contact.createMany({ data: [
    { organizationId: org.id, name: 'Ana', phone: '595981000001', tags: ['vip'] },
    { organizationId: org.id, name: 'Beto', phone: '595981000002', tags: [] }
  ] });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  const created = await agent.post('/api/org/api-keys').set('X-CSRF-Token', csrfToken).send({ name: 'Integración' });
  expect(created.status).toBe(201);
  return { org, secret: created.body.secret, agent, csrfToken };
}

const withKey = (secret, req) => req.set('Authorization', `Bearer ${secret}`);

describe('API pública: estados de WhatsApp', () => {
  test('publica un estado de texto y queda registrado con su audiencia', async () => {
    const { secret, org } = await setup();
    const res = await withKey(secret, request(app).post('/api/v1/status')).send({
      contentType: 'text', textContent: '¡Hoy 20% de descuento! 🎉', backgroundColor: '#075E54', audienceType: 'ALL'
    });
    expect(res.status).toBe(201);
    expect(res.body.status.contentType).toBe('text');
    expect(res.body.status.audienceCount).toBe(2);

    const stored = await prisma.whatsappStatusPost.findFirst({ where: { organizationId: org.id } });
    expect(stored.textContent).toContain('20% de descuento');
  });

  test('publica una imagen subida como archivo y deduce el tipo', async () => {
    const { secret } = await setup();
    const res = await withKey(secret, request(app).post('/api/v1/status'))
      .field('caption', 'Nueva colección')
      .field('audienceType', 'ALL')
      .attach('file', PNG, { filename: 'promo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.status.contentType).toBe('image');
    expect(res.body.status.caption).toBe('Nueva colección');
  });

  test('acepta imagen en base64 (sin multipart)', async () => {
    const { secret } = await setup();
    const res = await withKey(secret, request(app).post('/api/v1/status')).send({
      contentType: 'image', mediaBase64: PNG.toString('base64'), mimeType: 'image/png', caption: 'Desde base64'
    });
    expect(res.status).toBe(201);
    expect(res.body.status.contentType).toBe('image');
  });

  test('permite programar y filtrar la audiencia por etiqueta', async () => {
    const { secret } = await setup();
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await withKey(secret, request(app).post('/api/v1/status')).send({
      contentType: 'text', textContent: 'Promo de mañana', mode: 'SCHEDULED', scheduledAt,
      audienceType: 'TAG', audienceTags: ['vip']
    });
    expect(res.status).toBe(201);
    expect(res.body.status.status).toBe('scheduled');
    expect(res.body.status.audienceCount).toBe(1);
  });

  test('se puede consultar una publicación y listar las últimas', async () => {
    const { secret } = await setup();
    const created = await withKey(secret, request(app).post('/api/v1/status')).send({ contentType: 'text', textContent: 'Hola' });
    const detail = await withKey(secret, request(app).get(`/api/v1/status/${created.body.status.id}`));
    expect(detail.status).toBe(200);
    expect(detail.body.status.id).toBe(created.body.status.id);

    const list = await withKey(secret, request(app).get('/api/v1/status?limit=5'));
    expect(list.status).toBe(200);
    expect(list.body.statuses).toHaveLength(1);
  });

  test('rechaza texto vacío, fecha pasada y claves de otra organización', async () => {
    const { secret } = await setup();
    expect((await withKey(secret, request(app).post('/api/v1/status')).send({ contentType: 'text', textContent: '   ' })).status).toBe(400);
    expect((await withKey(secret, request(app).post('/api/v1/status')).send({ contentType: 'text', textContent: 'x', mode: 'SCHEDULED', scheduledAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await request(app).post('/api/v1/status').send({ contentType: 'text', textContent: 'x' })).status).toBe(401);

    const otra = await setup('-2');
    const mio = await withKey(secret, request(app).post('/api/v1/status')).send({ contentType: 'text', textContent: 'privado' });
    const ajeno = await withKey(otra.secret, request(app).get(`/api/v1/status/${mio.body.status.id}`));
    expect(ajeno.status).toBe(404);
  });

  test('la documentación OpenAPI incluye los estados', async () => {
    const docs = await request(app).get('/api/v1/openapi.json');
    expect(docs.status).toBe(200);
    expect(Object.keys(docs.body.paths)).toEqual(expect.arrayContaining(['/status', '/status/{id}']));
  });
});
