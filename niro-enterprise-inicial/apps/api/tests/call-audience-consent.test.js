const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const calls = require('../src/lib/callCampaigns');

beforeEach(async () => { process.env.WHATSAPP_CALL_PROVIDER = 'mock'; await resetDb(); });
afterAll(async () => { await calls.shutdown(); delete process.env.WHATSAPP_CALL_PROVIDER; await resetDb(); await prisma.$disconnect(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `ca-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@ca.test`, role: 'OWNER' });
  const agentUser = await createUser(prisma, { organizationId: org.id, email: `a${Date.now()}@ca.test`, role: 'AGENT' });
  const account = await prisma.callAccount.create({ data: { organizationId: org.id, name: 'WA', sessionReference: 'mock', status: 'CONNECTED' } });
  const audio = await prisma.callAudio.create({ data: { organizationId: org.id, name: 'Promo', storageKey: 'x.mp3', mimeType: 'audio/mpeg', size: 1000 } });
  const ana = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana Gómez', phone: '595981000001', tags: ['vip'] } });
  const sinNombre = await prisma.contact.create({ data: { organizationId: org.id, phone: '595981000002' } });
  const baja = await prisma.contact.create({ data: { organizationId: org.id, name: 'Baja', phone: '595981000003', callOptedOutAt: new Date() } });
  await prisma.conversation.create({ data: { organizationId: org.id, contactId: ana.id, channel: 'whatsapp', tags: ['Clientes'] } });
  return { org, account, audio, ana, sinNombre, baja, admin: await loginAgent(app, owner.email), agent: await loginAgent(app, agentUser.email) };
}
const post = (s, path, body) => s.agent.post(path).set('X-CSRF-Token', s.csrfToken).send(body);

describe('Audiencia y consentimiento de llamadas', () => {
  test('el listado trae nombre, número, etapa CRM, etiquetas y consentimiento', async () => {
    const { admin, ana } = await setup();
    const res = await admin.agent.get('/api/org/wa-calls/audience');
    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(3);
    const a = res.body.contacts.find((c) => c.id === ana.id);
    expect(a).toMatchObject({ name: 'Ana Gómez', phone: '595981000001', crmTags: ['Clientes'], tags: ['vip'] });
    expect(res.body.contacts.find((c) => c.callOptedOutAt)).toBeTruthy();
  });

  test('sin consentimiento no se puede crear la campaña; con la declaración explícita sí', async () => {
    const s = await setup();
    const body = { name: 'Llamadas', accountId: s.account.id, audioId: s.audio.id, contactIds: [s.ana.id, s.sinNombre.id] };
    const blocked = await post(s.admin, '/api/org/wa-calls/campaigns', body);
    expect(blocked.status).toBe(400);

    // exige confirmación explícita
    expect((await post(s.admin, '/api/org/wa-calls/consent', { contactIds: [s.ana.id, s.sinNombre.id] })).status).toBe(400);
    const granted = await post(s.admin, '/api/org/wa-calls/consent', { contactIds: [s.ana.id, s.sinNombre.id, s.baja.id], confirm: true, source: 'Clientes que aceptaron por WhatsApp' });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ granted: 2, skippedOptedOut: 1 });

    const stored = await prisma.contact.findUnique({ where: { id: s.ana.id } });
    expect(stored.callConsentStatus).toBe('GRANTED');
    expect(stored.callConsentSource).toContain('Clientes que aceptaron por WhatsApp');
    expect(stored.callConsentAt).toBeTruthy();
    // quien pidió no ser llamado nunca queda autorizado
    expect((await prisma.contact.findUnique({ where: { id: s.baja.id } })).callConsentStatus).not.toBe('GRANTED');
    expect(await prisma.callAuditLog.count({ where: { action: 'call.consent.granted' } })).toBe(1);

    const ok = await post(s.admin, '/api/org/wa-calls/campaigns', { ...body, contactIds: [s.ana.id, s.sinNombre.id, s.baja.id] });
    expect(ok.status).toBe(201);
    expect(ok.body.accepted).toBe(2);
    expect(ok.body.rejected.map((r) => r.reason)).toContain('Contacto excluido de llamadas');
  });

  test('un agente no puede declarar consentimiento', async () => {
    const s = await setup();
    const res = await post(s.agent, '/api/org/wa-calls/consent', { contactIds: [s.ana.id], confirm: true });
    expect(res.status).toBe(403);
    expect((await prisma.contact.findUnique({ where: { id: s.ana.id } })).callConsentStatus).not.toBe('GRANTED');
  });

  test('otra organización no puede tocar mis contactos', async () => {
    const s = await setup();
    const other = await createOrganization(prisma, { slug: `ca2-${Date.now()}` });
    await prisma.organization.update({ where: { id: other.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
    const u = await createUser(prisma, { organizationId: other.id, email: `x${Date.now()}@ca2.test`, role: 'OWNER' });
    const intruder = await loginAgent(app, u.email);
    const res = await post(intruder, '/api/org/wa-calls/consent', { contactIds: [s.ana.id], confirm: true });
    expect(res.body.granted).toBe(0);
    expect((await prisma.contact.findUnique({ where: { id: s.ana.id } })).callConsentStatus).not.toBe('GRANTED');
    expect((await intruder.agent.get('/api/org/wa-calls/audience')).body.contacts).toHaveLength(0);
  });
});
