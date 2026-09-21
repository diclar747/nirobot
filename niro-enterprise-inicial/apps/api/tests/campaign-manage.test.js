const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const campaigns = require('../src/lib/campaigns');

beforeEach(async () => { await resetDb(); });
afterAll(async () => { campaigns.clearAllTimers(); await resetDb(); await prisma.$disconnect(); });

const send = (s, method, path, body) => s.agent[method](path).set('X-CSRF-Token', s.csrfToken).send(body);

async function setup() {
  const org = await createOrganization(prisma, { slug: `wm-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@wm.test`, role: 'OWNER' });
  const contacts = [];
  for (const phone of ['595981000001', '595981000002', '595981000003']) {
    contacts.push(await prisma.contact.create({ data: { organizationId: org.id, name: `C${phone.slice(-1)}`, phone } }));
  }
  const session = await loginAgent(app, owner.email);
  const body = (extra = {}) => ({ name: 'Promo', message: 'Hola {nombre}', contactIds: [contacts[0].id, contacts[1].id], ...extra });
  return { org, owner, contacts, session, body };
}

describe('Campañas de WhatsApp: editar, eliminar y limpiar historial', () => {
  test('edita una campaña pendiente: mensaje, destinatarios y velocidad', async () => {
    const { session, body, contacts } = await setup();
    const id = (await send(session, 'post', '/api/org/campaigns', body())).body.campaign.id;
    const res = await send(session, 'patch', `/api/org/campaigns/${id}`, body({ name: 'Editada', message: 'Nuevo {{nombre}}', contactIds: [contacts[2].id], speedProfile: 'PERFORMANCE', messagesPerHour: 60 }));
    expect(res.status).toBe(200);
    expect(res.body.campaign).toMatchObject({ name: 'Editada', message: 'Nuevo {{nombre}}', speedProfile: 'PERFORMANCE', status: 'DRAFT' });
    expect(res.body.campaign.counts.total).toBe(1);
    const config = await session.agent.get(`/api/org/campaigns/${id}/config`);
    expect(config.body.contactIds).toEqual([contacts[2].id]);
    // variable desconocida sigue rechazada al editar
    expect((await send(session, 'patch', `/api/org/campaigns/${id}`, body({ message: 'Hola {{apodo}}' }))).status).toBe(400);
  });

  test('programar al editar deja la campaña programada, y quitar la fecha la vuelve pendiente', async () => {
    const { session, body } = await setup();
    const id = (await send(session, 'post', '/api/org/campaigns', body())).body.campaign.id;
    const when = new Date(Date.now() + 3600000).toISOString();
    const sched = await send(session, 'patch', `/api/org/campaigns/${id}`, body({ campaignType: 'SCHEDULED', scheduledAt: when }));
    expect(sched.body.campaign.status).toBe('SCHEDULED');
    const back = await send(session, 'patch', `/api/org/campaigns/${id}`, body());
    expect(back.body.campaign.status).toBe('DRAFT');
    expect(back.body.campaign.scheduledAt).toBeNull();
  });

  test('no permite editar una campaña que está enviando o pausada', async () => {
    const { session, body } = await setup();
    const id = (await send(session, 'post', '/api/org/campaigns', body())).body.campaign.id;
    for (const status of ['SENDING', 'PAUSED']) {
      await prisma.campaign.update({ where: { id }, data: { status } });
      expect((await send(session, 'patch', `/api/org/campaigns/${id}`, body())).status).toBe(409);
    }
  });

  test('editar una campaña terminada la deja pendiente con los resultados reiniciados', async () => {
    const { session, body, contacts } = await setup();
    const id = (await send(session, 'post', '/api/org/campaigns', body())).body.campaign.id;
    await prisma.campaignRecipient.updateMany({ where: { campaignId: id }, data: { status: 'DELIVERED', sentAt: new Date() } });
    await prisma.campaign.update({ where: { id }, data: { status: 'COMPLETED', startedAt: new Date(), completedAt: new Date() } });
    const res = await send(session, 'patch', `/api/org/campaigns/${id}`, body({ message: 'Versión 2 para {{nombre}}', contactIds: [contacts[0].id, contacts[1].id, contacts[2].id] }));
    expect(res.status).toBe(200);
    expect(res.body.campaign).toMatchObject({ status: 'DRAFT', startedAt: null, completedAt: null, message: 'Versión 2 para {{nombre}}' });
    expect(res.body.campaign.counts).toMatchObject({ total: 3, pending: 3, sent: 0, delivered: 0 });
  });

  test('elimina la campaña pero conserva los mensajes ya enviados en el chat', async () => {
    const { session, body, org, contacts } = await setup();
    const id = (await send(session, 'post', '/api/org/campaigns', body())).body.campaign.id;
    const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contacts[0].id, channel: 'whatsapp' } });
    const message = await prisma.message.create({ data: { conversationId: conversation.id, direction: 'OUTBOUND', content: 'Hola', campaignId: id } });
    await prisma.campaign.update({ where: { id }, data: { status: 'SENDING' } });
    expect((await session.agent.delete(`/api/org/campaigns/${id}`).set('X-CSRF-Token', session.csrfToken)).status).toBe(409);
    await prisma.campaign.update({ where: { id }, data: { status: 'COMPLETED' } });
    expect((await session.agent.delete(`/api/org/campaigns/${id}`).set('X-CSRF-Token', session.csrfToken)).status).toBe(200);
    expect(await prisma.campaign.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.campaignRecipient.count({ where: { campaignId: id } })).toBe(0);
    const kept = await prisma.message.findUnique({ where: { id: message.id } });
    expect(kept).toBeTruthy();
    expect(kept.campaignId).toBeNull();
  });

  test('limpieza en lote: borra las terminadas, omite las que están enviando y respeta la organización', async () => {
    const { session, body, org } = await setup();
    const ids = [];
    for (const status of ['COMPLETED', 'CANCELLED', 'SENDING']) {
      const id = (await send(session, 'post', '/api/org/campaigns', body({ name: status }))).body.campaign.id;
      await prisma.campaign.update({ where: { id }, data: { status } });
      ids.push(id);
    }
    const other = await createOrganization(prisma, { slug: `wm2-${Date.now()}` });
    const foreign = await prisma.campaign.create({ data: { organizationId: other.id, name: 'Ajena', message: 'x', status: 'COMPLETED' } });
    const res = await send(session, 'post', '/api/org/campaigns/bulk-delete', { ids: [...ids, foreign.id] });
    expect(res.body.deleted.sort()).toEqual([ids[0], ids[1]].sort());
    expect(res.body.skipped.map((x) => x.id)).toEqual([ids[2]]);
    expect(await prisma.campaign.findUnique({ where: { id: foreign.id } })).toBeTruthy();
    expect(await prisma.campaign.count({ where: { organizationId: org.id } })).toBe(1);
    expect((await send(session, 'post', '/api/org/campaigns/bulk-delete', { ids: [] })).status).toBe(400);
  });

  test('un agente no puede editar ni eliminar campañas', async () => {
    const { session, body, org } = await setup();
    const id = (await send(session, 'post', '/api/org/campaigns', body())).body.campaign.id;
    const agent = await createUser(prisma, { organizationId: org.id, email: `ag${Date.now()}@wm.test`, role: 'AGENT' });
    const s = await loginAgent(app, agent.email);
    expect((await s.agent.delete(`/api/org/campaigns/${id}`).set('X-CSRF-Token', s.csrfToken)).status).toBe(403);
    expect((await send(s, 'patch', `/api/org/campaigns/${id}`, body())).status).toBe(403);
    expect((await send(s, 'post', '/api/org/campaigns/bulk-delete', { ids: [id] })).status).toBe(403);
  });
});
