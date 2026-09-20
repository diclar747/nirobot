const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');
const posts = require('../src/lib/statusPosts');

let connected;
let send;
let remove;

beforeEach(async () => {
  await resetDb();
  connected = true;
  jest.spyOn(whatsapp, 'getStatus').mockImplementation(() => ({ status: connected ? 'connected' : 'disconnected' }));
  send = jest.spyOn(whatsapp, 'sendStatusBroadcast').mockResolvedValue('WA-STATUS-1');
  remove = jest.spyOn(whatsapp, 'deleteStatusBroadcast').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

async function setup(role = 'ADMIN') {
  const org = await createOrganization(prisma, { slug: 'posts-co' });
  const user = await createUser(prisma, { organizationId: org.id, email: `u-${role}@posts.test`, role });
  await prisma.contact.createMany({ data: [
    { organizationId: org.id, name: 'Ana', phone: '595981000001', tags: ['vip'] },
    { organizationId: org.id, name: 'Beto', phone: '+595 981-000-002', tags: [] },
    { organizationId: org.id, name: 'Sin teléfono', phone: null },
    { organizationId: org.id, name: 'Inválido', phone: '12' }
  ] });
  return { org, session: await loginAgent(app, user.email) };
}
const post = (s, body) => s.agent.post('/api/org/status-posts').set('X-CSRF-Token', s.csrfToken).send(body);
async function waitFor(id, status) {
  const deadline = Date.now() + 5000;
  let row;
  while (Date.now() < deadline) {
    row = await prisma.whatsappStatusPost.findUnique({ where: { id } });
    if (row.status === status) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`esperaba ${status}, quedó ${row.status}`);
}

describe('publicar estados desde Nirobot', () => {
  test('texto inmediato: audiencia normalizada, color y vencimiento a 24 h', async () => {
    const { session } = await setup();
    const res = await post(session, { contentType: 'text', textContent: 'Hola clientes', backgroundColor: '#112233', audienceType: 'ALL' });
    expect(res.status).toBe(201);
    expect(res.body.post.audienceCount).toBe(2);
    const done = await waitFor(res.body.post.id, 'published');
    expect(done.waMessageId).toBe('WA-STATUS-1');
    expect(done.expiresAt.getTime() - done.publishedAt.getTime()).toBe(24 * 3600 * 1000);
    const [content, options, jids] = send.mock.calls[0].slice(1);
    expect(content).toEqual({ text: 'Hola clientes' });
    expect(options).toMatchObject({ backgroundColor: '#112233' });
    expect(jids.sort()).toEqual(['595981000001@s.whatsapp.net', '595981000002@s.whatsapp.net']);
    expect(await prisma.whatsappStatusAttempt.count({ where: { postId: done.id, successful: true } })).toBe(1);
  });

  test('audiencia por etiqueta y vista previa; audiencia vacía se rechaza', async () => {
    const { session } = await setup();
    const preview = await session.agent.get('/api/org/status-posts/audience-preview?audienceType=TAG&audienceTags=vip');
    expect(preview.body.count).toBe(1);
    expect((await post(session, { contentType: 'text', textContent: 'x', audienceType: 'TAG', audienceTags: ['no-existe'] })).status).toBe(400);
    expect((await post(session, { contentType: 'text', textContent: '  ', audienceType: 'ALL' })).status).toBe(400);
  });

  test('sin WhatsApp conectado no se crea una publicación inmediata (409)', async () => {
    const { session } = await setup();
    connected = false;
    expect((await post(session, { contentType: 'text', textContent: 'x', audienceType: 'ALL' })).status).toBe(409);
    expect(await prisma.whatsappStatusPost.count()).toBe(0);
  });

  test('imagen programada: valida fecha, formato y se publica cuando vence', async () => {
    const { session } = await setup();
    const send$ = (fields, file) => {
      let r = session.agent.post('/api/org/status-posts').set('X-CSRF-Token', session.csrfToken);
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return file ? r.attach('file', file.buf, file.name) : r;
    };
    const base = { contentType: 'image', audienceType: 'ALL', mode: 'SCHEDULED', caption: 'Oferta' };
    const png = { buf: Buffer.from('89504e470d0a1a0a', 'hex'), name: 'oferta.png' };
    expect((await send$({ ...base, scheduledAt: new Date(Date.now() - 60000).toISOString() }, png)).status).toBe(400);
    expect((await send$({ ...base, scheduledAt: new Date(Date.now() + 3600000).toISOString() }, { buf: Buffer.from('x'), name: 'a.exe' })).status).toBe(400);
    expect((await send$({ ...base, scheduledAt: new Date(Date.now() + 3600000).toISOString() })).status).toBe(400);

    const created = await send$({ ...base, scheduledAt: new Date(Date.now() + 3600000).toISOString() }, png);
    expect(created.status).toBe(201);
    expect(created.body.post.status).toBe('scheduled');
    expect(await posts.runDue()).toMatchObject({ due: 0 });

    await prisma.whatsappStatusPost.update({ where: { id: created.body.post.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await posts.runDue()).toMatchObject({ due: 1, published: 1 });
    const content = send.mock.calls[0][1];
    expect(Buffer.isBuffer(content.image)).toBe(true);
    expect(content).toMatchObject({ caption: 'Oferta', mimetype: 'image/png' });
    expect((await session.agent.get(created.body.post.mediaUrl)).status).toBe(200);
  });

  test('dos ticks simultáneos no publican dos veces (idempotencia)', async () => {
    const { session } = await setup();
    const created = await post(session, { contentType: 'text', textContent: 'una vez', audienceType: 'ALL', mode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 60000).toISOString() });
    await prisma.whatsappStatusPost.update({ where: { id: created.body.post.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await Promise.all([posts.runDue(), posts.runDue(), posts.runDue()]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('reintenta con espera creciente y falla tras el tercer reintento', async () => {
    const { session } = await setup();
    send.mockRejectedValue(new Error('timeout de red'));
    const created = await post(session, { contentType: 'text', textContent: 'x', audienceType: 'ALL', mode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 60000).toISOString() });
    const id = created.body.post.id;
    const due = () => prisma.whatsappStatusPost.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await due(); await posts.runDue();
    let row = await prisma.whatsappStatusPost.findUnique({ where: { id } });
    expect(row).toMatchObject({ status: 'scheduled', retryCount: 1 });
    expect(Math.round((row.nextAttemptAt.getTime() - Date.now()) / 60000)).toBe(1);
    await due(); await posts.runDue();
    row = await prisma.whatsappStatusPost.findUnique({ where: { id } });
    expect(Math.round((row.nextAttemptAt.getTime() - Date.now()) / 60000)).toBe(5);
    await due(); await posts.runDue();
    await due(); await posts.runDue();
    row = await prisma.whatsappStatusPost.findUnique({ where: { id } });
    expect(row).toMatchObject({ status: 'failed', retryCount: 3 });
    expect(await prisma.whatsappStatusAttempt.count({ where: { postId: id } })).toBe(4);
  });

  test('una publicación interrumpida por un reinicio no se reenvía a ciegas', async () => {
    const { org } = await setup();
    const stuck = await prisma.whatsappStatusPost.create({ data: { organizationId: org.id, contentType: 'text', textContent: 'x', audienceType: 'ALL', publicationMode: 'NOW', status: 'processing' } });
    await prisma.$executeRaw`UPDATE "WhatsappStatusPost" SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${stuck.id}`;
    expect(await posts.recoverStuck()).toBe(1);
    expect((await prisma.whatsappStatusPost.findUnique({ where: { id: stuck.id } })).status).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });

  test('eliminar un estado publicado intenta retirarlo de WhatsApp', async () => {
    const { session } = await setup();
    const created = await post(session, { contentType: 'text', textContent: 'borrar', audienceType: 'ALL' });
    await waitFor(created.body.post.id, 'published');
    const res = await session.agent.delete(`/api/org/status-posts/${created.body.post.id}`).set('X-CSRF-Token', session.csrfToken);
    expect(res.status).toBe(200);
    expect(res.body.post.status).toBe('deleted');
    expect(remove).toHaveBeenCalledWith(expect.any(String), 'WA-STATUS-1', expect.any(Array));
  });

  test('duplicar crea un borrador que se puede publicar', async () => {
    const { session } = await setup();
    const created = await post(session, { contentType: 'text', textContent: 'repetir', audienceType: 'ALL' });
    await waitFor(created.body.post.id, 'published');
    const copy = await session.agent.post(`/api/org/status-posts/${created.body.post.id}/duplicate`).set('X-CSRF-Token', session.csrfToken);
    expect(copy.status).toBe(201);
    expect(copy.body.post.status).toBe('draft');
    const published = await session.agent.post(`/api/org/status-posts/${copy.body.post.id}/publish`).set('X-CSRF-Token', session.csrfToken);
    expect(published.status).toBe(202);
    await waitFor(copy.body.post.id, 'published');
  });

  test('un AGENT no accede y otra organización no ve las publicaciones ajenas', async () => {
    const { session } = await setup();
    const created = await post(session, { contentType: 'text', textContent: 'privado', audienceType: 'ALL' });
    const other = await createOrganization(prisma, { slug: 'otra-co' });
    await createUser(prisma, { organizationId: other.id, email: 'admin@otra.test', role: 'ADMIN' });
    await createUser(prisma, { organizationId: other.id, email: 'agente@otra.test', role: 'AGENT' });
    const foreign = await loginAgent(app, 'admin@otra.test');
    expect((await foreign.agent.get('/api/org/status-posts')).body.posts).toHaveLength(0);
    expect((await foreign.agent.get(`/api/org/status-posts/${created.body.post.id}`)).status).toBe(404);
    expect((await foreign.agent.delete(`/api/org/status-posts/${created.body.post.id}`).set('X-CSRF-Token', foreign.csrfToken)).status).toBe(404);
    const agentSession = await loginAgent(app, 'agente@otra.test');
    expect((await agentSession.agent.get('/api/org/status-posts')).status).toBe(403);
    expect((await request(app).get('/api/org/status-posts')).status).toBe(401);
  });
});
