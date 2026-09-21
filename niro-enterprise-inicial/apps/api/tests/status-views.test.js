const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { recordStatusActivity, countsFor } = require('../src/lib/statusViews');

let org, admin, post;
beforeAll(async () => {
  await resetDb();
  org = await createOrganization(prisma, { slug: `sv-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@sv.test`, role: 'OWNER' });
  admin = await loginAgent(app, owner.email);
  await prisma.contact.create({ data: { organizationId: org.id, name: 'María González', phone: '595981000001' } });
  post = await prisma.whatsappStatusPost.create({ data: { organizationId: org.id, contentType: 'text', textContent: 'Oferta', audienceType: 'ALL', publicationMode: 'NOW', status: 'published', waMessageId: 'WAID1', audienceCount: 3, publishedAt: new Date(), expiresAt: new Date(Date.now() + 86400000) } });
});
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

describe('Vistas y me gusta de los estados propios', () => {
  test('registra quién vio el estado, con su nombre del CRM y la hora', async () => {
    const seen = new Date('2026-09-21T15:00:00Z');
    await recordStatusActivity(org.id, { waMessageId: 'WAID1', viewerJid: '595981000001@s.whatsapp.net', phone: '595981000001', viewedAt: seen });
    await recordStatusActivity(org.id, { waMessageId: 'WAID1', viewerJid: '595982999999@s.whatsapp.net', phone: '595982999999', viewedAt: new Date('2026-09-21T15:05:00Z') });
    const res = await admin.agent.get(`/api/org/status-posts/${post.id}/views`);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ views: 2, reactions: 0 });
    expect(res.body.audienceCount).toBe(3);
    expect(res.body.views[0]).toMatchObject({ phone: '595982999999', name: null }); // el más reciente primero
    expect(res.body.views[1]).toMatchObject({ phone: '595981000001', name: 'María González' });
    expect(new Date(res.body.views[1].viewedAt).toISOString()).toBe(seen.toISOString());
  });

  test('el me gusta se suma al visitante; una vista posterior no borra la reacción ni cambia la primera hora', async () => {
    const jid = '595981000001@s.whatsapp.net';
    await recordStatusActivity(org.id, { waMessageId: 'WAID1', viewerJid: jid, phone: '595981000001', hasReaction: true, reaction: '❤️', reactedAt: new Date('2026-09-21T15:10:00Z') });
    await recordStatusActivity(org.id, { waMessageId: 'WAID1', viewerJid: jid, phone: '595981000001', viewedAt: new Date('2026-09-21T16:00:00Z') });
    const row = await prisma.whatsappStatusView.findFirst({ where: { organizationId: org.id, waMessageId: 'WAID1', viewerJid: jid } });
    expect(row.reaction).toBe('❤️');
    expect(row.viewedAt.toISOString()).toBe('2026-09-21T15:00:00.000Z');
    expect(await countsFor(org.id, 'WAID1')).toEqual({ views: 2, reactions: 1 });
    expect(await prisma.whatsappStatusView.count({ where: { organizationId: org.id, waMessageId: 'WAID1' } })).toBe(2); // sin duplicados
  });

  test('quitar el me gusta borra la reacción; reaccionar sin haber "visto" cuenta también como vista', async () => {
    const jid = '595981000001@s.whatsapp.net';
    await recordStatusActivity(org.id, { waMessageId: 'WAID1', viewerJid: jid, phone: '595981000001', hasReaction: true, reaction: null });
    expect((await countsFor(org.id, 'WAID1')).reactions).toBe(0);
    await recordStatusActivity(org.id, { waMessageId: 'WAID1', viewerJid: '595983000000@s.whatsapp.net', phone: '595983000000', hasReaction: true, reaction: '👍', reactedAt: new Date('2026-09-21T17:00:00Z') });
    expect(await countsFor(org.id, 'WAID1')).toEqual({ views: 3, reactions: 1 });
  });

  test('la lista de publicaciones trae los contadores y otra empresa no ve estas vistas', async () => {
    const list = await admin.agent.get('/api/org/status-posts');
    const item = list.body.posts.find((p) => p.id === post.id);
    expect(item).toMatchObject({ viewCount: 3, reactionCount: 1 });
    const other = await createOrganization(prisma, { slug: `sv2-${Date.now()}` });
    expect(await countsFor(other.id, 'WAID1')).toEqual({ views: 0, reactions: 0 });
    expect((await admin.agent.get('/api/org/status-posts/inexistente/views')).status).toBe(404);
  });

  test('un estado sin id de WhatsApp (borrador) devuelve la lista vacía', async () => {
    const draft = await prisma.whatsappStatusPost.create({ data: { organizationId: org.id, contentType: 'text', textContent: 'x', audienceType: 'ALL', publicationMode: 'NOW', status: 'draft' } });
    const res = await admin.agent.get(`/api/org/status-posts/${draft.id}/views`);
    expect(res.body).toMatchObject({ views: [], counts: { views: 0, reactions: 0 } });
  });
});
