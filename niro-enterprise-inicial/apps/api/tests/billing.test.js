const crypto = require('crypto');
const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const billing = require('../src/lib/billing');

afterAll(async () => {
  await prisma.platformNoticeRead.deleteMany();
  await prisma.platformNotice.deleteMany();
  await prisma.billingPayment.deleteMany();
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.platformNoticeRead.deleteMany();
  await prisma.platformNotice.deleteMany();
  await prisma.billingPayment.deleteMany();
  await resetDb();
});

async function setup(orgData = {}) {
  const organization = await createOrganization(prisma, { slug: `bill-${Date.now()}` });
  if (Object.keys(orgData).length) await prisma.organization.update({ where: { id: organization.id }, data: orgData });
  const owner = await createUser(prisma, { organizationId: organization.id, email: `owner${Date.now()}@bill.test`, role: 'OWNER' });
  const session = await loginAgent(app, owner.email);
  return { organization, ...session };
}

describe('accessFor', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const hours = (n) => new Date(now.getTime() + n * 3600 * 1000);
  test('prueba de 24 h: dentro, vencida, pagada y sin cargo', () => {
    expect(billing.accessFor({ createdAt: hours(-1), trialEndsAt: null, paidUntil: null }, now).state).toBe('trial');
    expect(billing.accessFor({ createdAt: hours(-25), trialEndsAt: null, paidUntil: null }, now).state).toBe('expired');
    expect(billing.accessFor({ createdAt: hours(-99), trialEndsAt: hours(-50), paidUntil: hours(10) }, now).state).toBe('active');
    expect(billing.accessFor({ createdAt: hours(-99), trialEndsAt: hours(-50), paidUntil: hours(-1) }, now).blocked).toBe(true);
    expect(billing.accessFor({ createdAt: hours(-99), trialEndsAt: hours(-50), paidUntil: null, billingExempt: true }, now).state).toBe('exempt');
  });
});

describe('Prueba gratuita y bloqueo', () => {
  test('en prueba se puede usar la API', async () => {
    const { agent } = await setup({ trialEndsAt: new Date(Date.now() + 3600 * 1000) });
    const res = await agent.get('/api/org/contacts');
    expect(res.status).toBe(200);
    const status = await agent.get('/api/org/billing/status');
    expect(status.body.access.state).toBe('trial');
    expect(status.body.access.priceGs).toBe(49000);
  });

  test('vencida: la API responde 402 pero facturación sigue abierta', async () => {
    const { agent } = await setup({ trialEndsAt: new Date(Date.now() - 1000) });
    const blocked = await agent.get('/api/org/contacts');
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('SUBSCRIPTION_REQUIRED');
    const status = await agent.get('/api/org/billing/status');
    expect(status.status).toBe(200);
    expect(status.body.access.state).toBe('expired');
  });

  test('un plan pagado desbloquea y "sin cargo" nunca bloquea', async () => {
    const paid = await setup({ trialEndsAt: new Date(Date.now() - 1000), paidUntil: new Date(Date.now() + 86400000) });
    expect((await paid.agent.get('/api/org/contacts')).status).toBe(200);
    await resetDb();
    const exempt = await setup({ trialEndsAt: new Date(Date.now() - 1000), billingExempt: true });
    expect((await exempt.agent.get('/api/org/contacts')).status).toBe(200);
  });
});

describe('Webhook de Winsap', () => {
  async function pendingPayment(organization) {
    return prisma.billingPayment.create({ data: { organizationId: organization.id, amount: 49000, winsapLinkId: '42', winsapLinkToken: 'tok123', paymentUrl: 'https://winsap.test/pay/tok123' } });
  }
  const sign = (raw) => `sha256=${crypto.createHmac('sha256', billing.webhookSecret()).update(raw).digest('hex')}`;

  test('firma válida acredita 30 días y desbloquea', async () => {
    const { organization, agent } = await setup({ trialEndsAt: new Date(Date.now() - 1000) });
    const payment = await pendingPayment(organization);
    const body = JSON.stringify({ event: 'payment.paid', data: { id: 501, reference: payment.id, status: 'paid', payment_method: 'Bancard Tpago' } });
    const res = await request(app).post('/api/billing/webhook/winsap').set('Content-Type', 'application/json').set('X-Winsap-Signature', sign(body)).send(body);
    expect(res.status).toBe(200);
    const updated = await prisma.billingPayment.findUnique({ where: { id: payment.id } });
    expect(updated.status).toBe('paid');
    const org = await prisma.organization.findUnique({ where: { id: organization.id } });
    const days = (org.paidUntil.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect((await agent.get('/api/org/contacts')).status).toBe(200);
  });

  test('firma inválida se rechaza y el webhook repetido no suma dos veces', async () => {
    const { organization } = await setup({ trialEndsAt: new Date(Date.now() - 1000) });
    const payment = await pendingPayment(organization);
    const body = JSON.stringify({ event: 'payment.paid', data: { reference: payment.id } });
    const bad = await request(app).post('/api/billing/webhook/winsap').set('Content-Type', 'application/json').set('X-Winsap-Signature', 'sha256=deadbeef').send(body);
    expect(bad.status).toBe(401);
    expect((await prisma.billingPayment.findUnique({ where: { id: payment.id } })).status).toBe('pending');
    for (let i = 0; i < 2; i += 1) {
      await request(app).post('/api/billing/webhook/winsap').set('Content-Type', 'application/json').set('X-Winsap-Signature', sign(body)).send(body);
    }
    const org = await prisma.organization.findUnique({ where: { id: organization.id } });
    expect((org.paidUntil.getTime() - Date.now()) / 86400000).toBeLessThan(30.1);
  });
});

describe('Superadmin: clientes y avisos', () => {
  test('overview clasifica pagados / prueba / vencidos y los avisos llegan a su audiencia', async () => {
    const sa = await createUser(prisma, { organizationId: null, email: 'root@bill.test', role: 'SUPERADMIN' });
    const paidOrg = await createOrganization(prisma, { slug: 'paid-org' });
    await prisma.organization.update({ where: { id: paidOrg.id }, data: { paidUntil: new Date(Date.now() + 86400000), trialEndsAt: new Date(Date.now() - 1000) } });
    const expiredOrg = await createOrganization(prisma, { slug: 'expired-org' });
    await prisma.organization.update({ where: { id: expiredOrg.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    const owner = await createUser(prisma, { organizationId: expiredOrg.id, email: 'owner@expired.test', role: 'OWNER' });
    await prisma.callAccount.create({ data: { organizationId: expiredOrg.id, name: 'WA', phoneNumber: '595981000000', status: 'CONNECTED' } });
    await prisma.callAccount.create({ data: { organizationId: paidOrg.id, name: 'WA', phoneNumber: '595982000000', status: 'CONNECTED' } });

    const { agent, csrfToken } = await loginAgent(app, sa.email);
    const overview = await agent.get('/api/superadmin/billing/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.summary.active).toBe(1);
    expect(overview.body.summary.expired).toBe(1);

    const created = await agent.post('/api/superadmin/notices').set('X-CSRF-Token', csrfToken).send({ title: 'Hola', body: 'Aviso a vencidos', audience: 'expired' });
    expect(created.status).toBe(201);

    const client = await loginAgent(app, owner.email);
    const notices = await client.agent.get('/api/org/billing/notices');
    expect(notices.body.notices.map((n) => n.title)).toContain('Hola');
    const read = await client.agent.post(`/api/org/billing/notices/${created.body.notice.id}/read`).set('X-CSRF-Token', client.csrfToken);
    expect(read.status).toBe(200);
    expect((await client.agent.get('/api/org/billing/notices')).body.notices[0].read).toBe(true);
  });
});

describe('Corte de envíos con el plan vencido', () => {
  const whatsapp = require('../src/lib/whatsapp');
  const campaigns = require('../src/lib/campaigns');

  test('una campaña en curso se pausa en vez de enviar', async () => {
    const { organization } = await setup({ trialEndsAt: new Date(Date.now() - 1000) });
    require('../src/lib/billing').clearBlockedCache();
    const contact = await prisma.contact.create({ data: { organizationId: organization.id, name: 'Ana', phone: '595981000001' } });
    const campaign = await prisma.campaign.create({ data: { organizationId: organization.id, name: 'C', message: 'Hola', status: 'SENDING', recipients: { create: [{ contactId: contact.id }] } } });
    const sent = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('X');
    jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected' });
    await campaigns.processNext(organization.id, campaign.id);
    expect(sent).not.toHaveBeenCalled();
    expect((await prisma.campaign.findUnique({ where: { id: campaign.id } })).status).toBe('PAUSED');
    campaigns.clearAllTimers();
    jest.restoreAllMocks();
  });

  test('al pagar se levanta el bloqueo (cache incluida)', async () => {
    const { organization } = await setup({ trialEndsAt: new Date(Date.now() - 1000) });
    const b = require('../src/lib/billing');
    b.clearBlockedCache();
    expect(await b.isBlocked(organization.id)).toBe(true);
    const payment = await prisma.billingPayment.create({ data: { organizationId: organization.id, amount: 49000 } });
    await b.activatePayment(payment);
    expect(await b.isBlocked(organization.id)).toBe(false);
  });
});
