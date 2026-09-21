const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const calls = require('../src/lib/callCampaigns');

beforeEach(async () => { process.env.WHATSAPP_CALL_PROVIDER = 'mock'; await resetDb(); });
afterAll(async () => { await calls.shutdown(); delete process.env.WHATSAPP_CALL_PROVIDER; await resetDb(); await prisma.$disconnect(); });

const send = (s, method, path, body) => s.agent[method](path).set('X-CSRF-Token', s.csrfToken).send(body);

async function setup() {
  const org = await createOrganization(prisma, { slug: `cm-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@cm.test`, role: 'OWNER' });
  const account = await prisma.callAccount.create({ data: { organizationId: org.id, name: 'WA', sessionReference: 'mock', status: 'CONNECTED' } });
  const audio = await prisma.callAudio.create({ data: { organizationId: org.id, name: 'Promo', storageKey: 'x.mp3', mimeType: 'audio/mpeg', size: 1000 } });
  const contacts = [];
  for (const phone of ['595981000001', '595981000002', '595981000003']) {
    contacts.push(await prisma.contact.create({ data: { organizationId: org.id, name: `C${phone.slice(-1)}`, phone, callConsentStatus: 'GRANTED' } }));
  }
  const session = await loginAgent(app, owner.email);
  const body = (extra = {}) => ({ name: 'Camp', accountId: account.id, audioId: audio.id, contactIds: [contacts[0].id, contacts[1].id], ...extra });
  return { org, owner, account, audio, contacts, session, body };
}

describe('Gestión de campañas de llamadas: editar, eliminar y relanzar', () => {
  test('edita una campaña en borrador: datos, destinatarios y encuesta', async () => {
    const { session, body, contacts } = await setup();
    const created = await send(session, 'post', '/api/org/wa-calls/campaigns', body());
    expect(created.status).toBe(201);
    const id = created.body.campaign.id;
    const edited = await send(session, 'patch', `/api/org/wa-calls/campaigns/${id}`, body({
      name: 'Editada', contactIds: [contacts[2].id], campaignType: 'FOLLOW_UP',
      surveyEnabled: true, surveyQuestion: '¿Querés info?',
      surveyOptions: [{ key: '1', label: 'Sí', action: 'INTERESTED', crmStage: 'clientes' }, { key: '2', label: 'No', action: 'OPT_OUT' }]
    }));
    expect(edited.status).toBe(200);
    expect(edited.body.campaign.name).toBe('Editada');
    expect(edited.body.campaign.campaignType).toBe('FOLLOW_UP');
    expect(edited.body.campaign.counts.total).toBe(1);

    const config = await session.agent.get(`/api/org/wa-calls/campaigns/${id}/config`);
    expect(config.body.recipients).toHaveLength(1);
    expect(config.body.survey.options.map((o) => [o.key, o.crmStage])).toEqual([['1', 'clientes'], ['2', '']]);

    // Quitar la encuesta al editar la elimina
    await send(session, 'patch', `/api/org/wa-calls/campaigns/${id}`, body({ name: 'Sin encuesta' }));
    expect(await prisma.callSurvey.findFirst({ where: { campaignId: id } })).toBeNull();
  });

  test('no permite editar una campaña que ya corrió ni una en curso', async () => {
    const { session, body } = await setup();
    const id = (await send(session, 'post', '/api/org/wa-calls/campaigns', body())).body.campaign.id;
    for (const status of ['COMPLETED', 'CANCELLED', 'RUNNING', 'PAUSED']) {
      await prisma.callCampaign.update({ where: { id }, data: { status } });
      expect((await send(session, 'patch', `/api/org/wa-calls/campaigns/${id}`, body())).status).toBe(409);
    }
  });

  test('elimina una campaña con su historial; una en curso no se puede eliminar', async () => {
    const { session, body, org } = await setup();
    const id = (await send(session, 'post', '/api/org/wa-calls/campaigns', body())).body.campaign.id;
    await prisma.callCampaign.update({ where: { id }, data: { status: 'RUNNING' } });
    expect((await session.agent.delete(`/api/org/wa-calls/campaigns/${id}`).set('X-CSRF-Token', session.csrfToken)).status).toBe(409);
    await prisma.callCampaign.update({ where: { id }, data: { status: 'COMPLETED' } });
    const del = await session.agent.delete(`/api/org/wa-calls/campaigns/${id}`).set('X-CSRF-Token', session.csrfToken);
    expect(del.status).toBe(200);
    expect(await prisma.callCampaign.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.callCampaignRecipient.count({ where: { campaignId: id } })).toBe(0);
    expect(await prisma.callAuditLog.findFirst({ where: { organizationId: org.id, action: 'call.campaign.deleted', entityId: id } })).toBeTruthy();
  });

  test('eliminación en lote: borra las terminadas, omite las en curso y respeta la organización', async () => {
    const { session, body, org } = await setup();
    const ids = [];
    for (const status of ['COMPLETED', 'CANCELLED', 'RUNNING']) {
      const id = (await send(session, 'post', '/api/org/wa-calls/campaigns', body({ name: status }))).body.campaign.id;
      await prisma.callCampaign.update({ where: { id }, data: { status } });
      ids.push(id);
    }
    const other = await createOrganization(prisma, { slug: `cm2-${Date.now()}` });
    const acc = await prisma.callAccount.create({ data: { organizationId: other.id, name: 'X', sessionReference: 'm', status: 'CONNECTED' } });
    const aud = await prisma.callAudio.create({ data: { organizationId: other.id, name: 'A', storageKey: 'y.mp3', mimeType: 'audio/mpeg', size: 1 } });
    const foreign = await prisma.callCampaign.create({ data: { organizationId: other.id, name: 'Ajena', accountId: acc.id, audioId: aud.id, status: 'COMPLETED' } });

    const res = await send(session, 'post', '/api/org/wa-calls/campaigns/bulk-delete', { ids: [...ids, foreign.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted.sort()).toEqual([ids[0], ids[1]].sort());
    expect(res.body.skipped.map((s) => s.id)).toEqual([ids[2]]);
    expect(await prisma.callCampaign.findUnique({ where: { id: foreign.id } })).toBeTruthy();
    expect(await prisma.callCampaign.count({ where: { organizationId: org.id } })).toBe(1);
    expect((await send(session, 'post', '/api/org/wa-calls/campaigns/bulk-delete', { ids: [] })).status).toBe(400);
  });

  test('un agente no puede eliminar ni editar campañas', async () => {
    const { session, body, org } = await setup();
    const id = (await send(session, 'post', '/api/org/wa-calls/campaigns', body())).body.campaign.id;
    const agent = await createUser(prisma, { organizationId: org.id, email: `ag${Date.now()}@cm.test`, role: 'AGENT' });
    const s = await loginAgent(app, agent.email);
    expect((await s.agent.delete(`/api/org/wa-calls/campaigns/${id}`).set('X-CSRF-Token', s.csrfToken)).status).toBe(403);
    expect((await send(s, 'patch', `/api/org/wa-calls/campaigns/${id}`, body())).status).toBe(403);
    expect((await send(s, 'post', '/api/org/wa-calls/campaigns/bulk-delete', { ids: [id] })).status).toBe(403);
  });

  test('limpia el historial de llamadas directas y conserva las que están en curso', async () => {
    const { session, org, account, contacts } = await setup();
    const base = { organizationId: org.id, accountId: account.id, contactId: contacts[0].id, phoneNumber: '595981000001' };
    const done = await prisma.callDirectRecord.create({ data: { ...base, status: 'COMPLETED' } });
    const live = await prisma.callDirectRecord.create({ data: { ...base, status: 'PLAYING' } });
    const res = await send(session, 'post', '/api/org/wa-calls/history/direct/bulk-delete', { ids: [done.id, live.id] });
    expect(res.body).toEqual({ deleted: 1, skipped: 1 });
    expect(await prisma.callDirectRecord.findUnique({ where: { id: live.id } })).toBeTruthy();
    expect((await send(session, 'post', '/api/org/wa-calls/history/direct/bulk-delete', { ids: [] })).status).toBe(400);
  });
});
