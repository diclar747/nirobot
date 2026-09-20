const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');
const posts = require('../src/lib/statusPosts');
const campaigns = require('../src/lib/statusCampaigns');

let send;
let remove;

beforeEach(async () => {
  await resetDb();
  jest.spyOn(whatsapp, 'getStatus').mockImplementation(() => ({ status: 'connected' }));
  send = jest.spyOn(whatsapp, 'sendStatusBroadcast').mockImplementation(async () => `WA-${Math.random()}`);
  remove = jest.spyOn(whatsapp, 'deleteStatusBroadcast').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: 'camp-co' });
  const user = await createUser(prisma, { organizationId: org.id, email: 'admin@camp.test', role: 'ADMIN' });
  await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana', phone: '595981000001' } });
  return { org, session: await loginAgent(app, user.email) };
}

function create(s, overrides = {}, items) {
  const startAt = overrides.startAt || new Date(Date.now() + 3600 * 1000).toISOString();
  const req = s.agent.post('/api/org/status-campaigns').set('X-CSRF-Token', s.csrfToken)
    .field('name', 'Producto X').field('intervalHours', String(overrides.intervalHours ?? 4)).field('startAt', startAt)
    .field('audienceType', 'ALL').field('replacePrevious', String(Boolean(overrides.replacePrevious)))
    .field('items', JSON.stringify(items || [
      { contentType: 'text', textContent: 'Día 1' },
      { contentType: 'text', textContent: 'Día 2' },
      { contentType: 'image', caption: 'Foto', fileIndex: 0 }
    ]));
  return overrides.noFile ? req : req.attach('files', Buffer.from('fakepng'), { filename: 'a.png', contentType: 'image/png' });
}

async function makeDue(campaignId, sequences) {
  await prisma.whatsappStatusPost.updateMany({ where: { campaignId, sequence: { in: sequences } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
}

describe('campañas de estados', () => {
  test('crea una publicación programada por ítem, espaciadas por el intervalo', async () => {
    const { session } = await setup();
    const res = await create(session);
    expect(res.status).toBe(201);
    expect(res.body.campaign).toMatchObject({ totalItems: 3, intervalHours: 4, status: 'active', pending: 3 });
    const items = await prisma.whatsappStatusPost.findMany({ where: { campaignId: res.body.campaign.id }, orderBy: { sequence: 'asc' } });
    expect(items.map((i) => i.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(items[1].nextAttemptAt.getTime() - items[0].nextAttemptAt.getTime()).toBe(4 * 3600 * 1000);
    expect(items[2].nextAttemptAt.getTime() - items[1].nextAttemptAt.getTime()).toBe(4 * 3600 * 1000);
    expect(items[2].mediaStorageKey).toBeTruthy();
  });

  test('valida intervalo, fecha, imagen faltante y audiencia', async () => {
    const { session } = await setup();
    expect((await create(session, { intervalHours: 5 })).status).toBe(400);
    expect((await create(session, { startAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await create(session, { noFile: true })).status).toBe(400);
    expect((await create(session, {}, [{ contentType: 'text', textContent: '  ' }])).status).toBe(400);
    expect(await prisma.whatsappStatusCampaign.count()).toBe(0);
    expect(await prisma.whatsappStatusPost.count()).toBe(0);
  });

  test('el worker publica solo lo vencido y completa la campaña', async () => {
    const { session } = await setup();
    const { body } = await create(session);
    const id = body.campaign.id;
    expect(await posts.runDue()).toEqual({ due: 0, published: 0 });
    await makeDue(id, [0]);
    expect((await posts.runDue()).published).toBe(1);
    await makeDue(id, [1, 2]);
    expect((await posts.runDue()).published).toBe(2);
    await posts.tick();
    const campaign = await prisma.whatsappStatusCampaign.findUnique({ where: { id } });
    expect(campaign.status).toBe('completed');
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('pausar frena al worker; reanudar corre lo vencido hacia adelante sin disparar todo junto', async () => {
    const { session } = await setup();
    const { body } = await create(session);
    const id = body.campaign.id;
    await makeDue(id, [0, 1]);
    await session.agent.post(`/api/org/status-campaigns/${id}/pause`).set('X-CSRF-Token', session.csrfToken).expect(200);
    expect((await posts.runDue()).published).toBe(0);
    const resumed = await session.agent.post(`/api/org/status-campaigns/${id}/resume`).set('X-CSRF-Token', session.csrfToken).expect(200);
    expect(resumed.body.campaign.status).toBe('active');
    expect((await posts.runDue()).published).toBe(0);
    const items = await prisma.whatsappStatusPost.findMany({ where: { campaignId: id }, orderBy: { sequence: 'asc' } });
    expect(items.every((i) => i.nextAttemptAt.getTime() > Date.now())).toBe(true);
    expect(items[1].nextAttemptAt.getTime()).toBeGreaterThanOrEqual(items[0].nextAttemptAt.getTime());
  });

  test('cancelar descarta lo pendiente y conserva lo ya publicado', async () => {
    const { session } = await setup();
    const { body } = await create(session);
    const id = body.campaign.id;
    await makeDue(id, [0]);
    await posts.runDue();
    const res = await session.agent.post(`/api/org/status-campaigns/${id}/cancel`).set('X-CSRF-Token', session.csrfToken).expect(200);
    expect(res.body.campaign).toMatchObject({ status: 'cancelled', published: 1, pending: 0 });
    const statuses = (await prisma.whatsappStatusPost.findMany({ where: { campaignId: id }, orderBy: { sequence: 'asc' } })).map((p) => p.status);
    expect(statuses).toEqual(['published', 'cancelled', 'cancelled']);
  });

  test('"reemplazar el anterior" retira el estado previo al publicar el siguiente', async () => {
    const { session } = await setup();
    const { body } = await create(session, { replacePrevious: true });
    const id = body.campaign.id;
    await makeDue(id, [0]);
    await posts.runDue();
    expect(remove).not.toHaveBeenCalled();
    await makeDue(id, [1]);
    await posts.runDue();
    expect(remove).toHaveBeenCalledTimes(1);
    const statuses = (await prisma.whatsappStatusPost.findMany({ where: { campaignId: id }, orderBy: { sequence: 'asc' } })).map((p) => p.status);
    expect(statuses).toEqual(['deleted', 'published', 'scheduled']);
  });

  test('lista y detalle; otra organización no ve la campaña', async () => {
    const { session } = await setup();
    const { body } = await create(session);
    const list = await session.agent.get('/api/org/status-campaigns').expect(200);
    expect(list.body.campaigns).toHaveLength(1);
    const detail = await session.agent.get(`/api/org/status-campaigns/${body.campaign.id}`).expect(200);
    expect(detail.body.posts).toHaveLength(3);
    const other = await createOrganization(prisma, { slug: 'other-co' });
    await createUser(prisma, { organizationId: other.id, email: 'x@other.test', role: 'ADMIN' });
    const s2 = await loginAgent(app, 'x@other.test');
    await s2.agent.get(`/api/org/status-campaigns/${body.campaign.id}`).expect(404);
    await s2.agent.post(`/api/org/status-campaigns/${body.campaign.id}/cancel`).set('X-CSRF-Token', s2.csrfToken).expect(404);
    expect(campaigns.ALLOWED_INTERVALS).toContain(24);
  });
});
