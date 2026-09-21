// Recorrido completo de un cliente de Nirobot, de punta a punta (WhatsApp simulado).
const crypto = require('crypto');
const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');
const campaigns = require('../src/lib/campaigns');
const billing = require('../src/lib/billing');

afterAll(async () => {
  await prisma.billingPayment.deleteMany();
  await resetDb();
  await prisma.$disconnect();
});
beforeAll(async () => { await prisma.billingPayment.deleteMany(); await resetDb(); });

const sign = (raw) => `sha256=${crypto.createHmac('sha256', billing.webhookSecret()).update(raw).digest('hex')}`;
let ctx = {};
const post = (s, path, body) => s.agent.post(path).set('X-CSRF-Token', s.csrfToken).send(body);
const patch = (s, path, body) => s.agent.patch(path).set('X-CSRF-Token', s.csrfToken).send(body);

describe('Recorrido del cliente', () => {
  test('1. onboarding: prueba de 24 h, propietario y equipo con cupo de prueba', async () => {
    const org = await createOrganization(prisma, { slug: 'journey-co' });
    await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 24 * 3600 * 1000) } });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@journey.test', role: 'OWNER' });
    ctx = { org, owner, admin: await loginAgent(app, owner.email) };

    const status = await ctx.admin.agent.get('/api/org/billing/status');
    expect(status.body.access.state).toBe('trial');
    expect(status.body.seats).toMatchObject({ maxAgents: 2, agentsUsed: 0 });

    const dept = await post(ctx.admin, '/api/org/departments', { name: 'Ventas' });
    expect(dept.status).toBe(201);
    ctx.dept = dept.body.department;

    const a1 = await post(ctx.admin, '/api/org/users', { name: 'Ana Agente', email: 'ana@journey.test', role: 'AGENT', password: 'correct-horse-battery-staple' });
    expect(a1.status).toBe(201);
    await prisma.user.update({ where: { id: a1.body.user.id }, data: { mustChangePassword: false } });
    ctx.anaUser = a1.body.user;
    ctx.ana = await loginAgent(app, 'ana@journey.test');
    expect(ctx.ana.user.permissions.campaigns).toBe(true); // por defecto todo activo
  });

  test('2. chat: envío, estados ✓ → ✓✓ → leído sin retroceder', async () => {
    const contact = await prisma.contact.create({ data: { organizationId: ctx.org.id, name: 'Carlos Cliente', phone: '595981555111', email: 'carlos@mail.com' } });
    ctx.contact = contact;
    jest.spyOn(whatsapp, 'sendText').mockResolvedValue('WA-MSG-1');
    jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected' });

    const conv = await post(ctx.admin, '/api/org/conversations', { contactId: contact.id, departmentId: ctx.dept.id, channel: 'whatsapp' });
    expect(conv.status).toBe(201);
    ctx.conv = conv.body.conversation;

    const sent = await post(ctx.admin, `/api/org/conversations/${ctx.conv.id}/messages`, { content: 'Hola Carlos, ¿en qué te ayudo?' });
    expect(sent.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    const row = await prisma.message.findFirst({ where: { conversationId: ctx.conv.id, direction: 'OUTBOUND', content: { contains: 'Carlos' } } });
    expect(row.senderUserId).toBe(ctx.owner.id);
    expect(['sent', 'pending']).toContain(row.deliveryStatus);

    await prisma.message.update({ where: { id: row.id }, data: { waMessageId: 'WA-MSG-1', deliveryStatus: 'sent' } });
    await campaigns.handleDeliveryUpdate('WA-MSG-1', 3);
    expect((await prisma.message.findUnique({ where: { id: row.id } })).deliveryStatus).toBe('delivered');
    await campaigns.handleDeliveryUpdate('WA-MSG-1', 4);
    expect((await prisma.message.findUnique({ where: { id: row.id } })).deliveryStatus).toBe('read');
    await campaigns.handleDeliveryUpdate('WA-MSG-1', 2); // recibo tardío: no baja de "leído"
    expect((await prisma.message.findUnique({ where: { id: row.id } })).deliveryStatus).toBe('read');
    const api = await ctx.admin.agent.get(`/api/org/conversations/${ctx.conv.id}`);
    const shown = api.body.messages.find((m) => m.content.includes('Carlos'));
    expect(shown.deliveryStatus).toBe('read');
    expect(shown.sender.name).toBeTruthy(); // etiqueta de quién respondió
  });

  test('3. bot de flujos: se lee, se guarda, se publica y responde en la prueba', async () => {
    const got = await ctx.admin.agent.get('/api/org/bot-flow');
    expect(got.status).toBe(200);
    const flow = { ...got.body.flow, enabled: true, published: true };
    const saved = await patch(ctx.admin, '/api/org/bot-flow', { flow });
    expect(saved.status).toBe(200);
    expect(saved.body.flow.enabled).toBe(true);
    const test = await post(ctx.admin, '/api/org/bot-flow/test', { message: 'hola' });
    expect(test.status).toBe(200);
    expect(Array.isArray(test.body.replies)).toBe(true);
  });

  test('4. transferencia: la nota llega en vivo a todos y el agente acepta', async () => {
    const t = await post(ctx.admin, `/api/org/conversations/${ctx.conv.id}/transfer`, { targetUserId: ctx.anaUser.id, note: 'Cliente VIP' });
    expect(t.status).toBe(200);
    expect(t.body.conversation.assignedTo.id).toBe(ctx.anaUser.id);
    const accept = await post(ctx.ana, `/api/org/conversations/${ctx.conv.id}/transfer-response`, { action: 'accept' });
    expect(accept.status).toBe(200);
    const msgs = await prisma.message.findMany({ where: { conversationId: ctx.conv.id, direction: 'NOTE' } });
    expect(msgs.some((m) => m.content.includes('TRANSFERENCIA'))).toBe(true);
    expect(msgs.some((m) => m.content.includes('aceptó'))).toBe(true);
    // el agente ya ve y puede responder
    const reply = await post(ctx.ana, `/api/org/conversations/${ctx.conv.id}/messages`, { content: 'Soy Ana, te ayudo' });
    expect(reply.status).toBe(201);
  });

  test('5. pedido: crear, avanzar de estado y listar', async () => {
    const created = await post(ctx.ana, '/api/org/orders', { contactId: ctx.contact.id, conversationId: ctx.conv.id, items: [{ name: 'Notebook', quantity: 2, unitPrice: 1500000 }] });
    expect(created.status).toBe(201);
    ctx.order = created.body.order;
    for (const status of ['CONFIRMED', 'DISPATCHED', 'DELIVERED']) {
      const up = await patch(ctx.ana, `/api/org/orders/${ctx.order.id}`, { status });
      expect(up.status).toBe(200);
      expect(up.body.order.status).toBe(status);
    }
    const list = await ctx.ana.agent.get('/api/org/orders');
    expect(list.body.orders.map((o) => o.id)).toContain(ctx.order.id);
  });

  test('6. CRM: enviar contacto a etapa y encontrarlo por etiqueta y etapa', async () => {
    await post(ctx.ana, `/api/org/contacts/${ctx.contact.id}`.replace(ctx.contact.id, `${ctx.contact.id}/crm`), { stage: 'Clientes' });
    await patch(ctx.admin, `/api/org/contacts/${ctx.contact.id}`, { tags: ['vip', 'notebook'] });
    const byStage = await ctx.ana.agent.get('/api/org/contacts/directory?stage=Clientes');
    expect(byStage.body.contacts.map((c) => c.id)).toContain(ctx.contact.id);
    const byTag = await ctx.ana.agent.get('/api/org/contacts/directory?tag=vip');
    expect(byTag.body.total).toBe(1);
    const csv = await ctx.ana.agent.get('/api/org/contacts/export.csv');
    expect(csv.text).toContain('Carlos Cliente');
  });

  test('7. reportes: reflejan la conversación y el pedido', async () => {
    const rep = await ctx.admin.agent.get('/api/org/reports/summary');
    expect(rep.status).toBe(200);
    expect(JSON.stringify(rep.body)).toMatch(/Carlos|DELIVERED|Ventas|total/i);
  });

  test('8. campaña personalizada + a grupos: cada uno recibe su texto', async () => {
    jest.spyOn(whatsapp, 'listGroups').mockResolvedValue([{ id: '120363@g.us', name: 'Clientes VIP', size: 12, announce: false, canSend: true }]);
    const sent = [];
    whatsapp.sendText.mockImplementation(async (_o, to, text) => { sent.push([to, text]); return `WA-${sent.length}`; });
    const created = await post(ctx.ana, '/api/org/campaigns', { name: 'Promo', message: 'Hola {{nombre}}, tu mail {{email}} · {{nombre_completo}}', contactIds: [ctx.contact.id], groupJids: ['120363@g.us'], messagesPerHour: 100 });
    expect(created.status).toBe(201);
    await prisma.campaign.update({ where: { id: created.body.campaign.id }, data: { status: 'SENDING' } });
    await campaigns.processNext(ctx.org.id, created.body.campaign.id);
    await campaigns.processNext(ctx.org.id, created.body.campaign.id);
    campaigns.clearAllTimers();
    const map = Object.fromEntries(sent);
    expect(map['595981555111']).toBe('Hola Carlos, tu mail carlos@mail.com · Carlos Cliente');
    expect(map['120363@g.us']).toBe('Hola Clientes, tu mail  · Clientes VIP'.replace('mail  ·', 'mail ·'));
  });

  test('9. permisos: el admin restringe a Ana y se aplica; el plan no se ve', async () => {
    await patch(ctx.admin, `/api/org/users/${ctx.anaUser.id}`, { permissions: { campaigns: false, reports: false } });
    expect((await ctx.ana.agent.get('/api/org/campaigns')).status).toBe(403);
    expect((await ctx.ana.agent.get('/api/org/reports/summary')).status).toBe(403);
    expect((await ctx.ana.agent.get('/api/org/orders')).status).toBe(200);
    const st = await ctx.ana.agent.get('/api/org/billing/status');
    expect(st.body.restricted).toBe(true);
    expect((await ctx.ana.agent.get('/api/org/billing/plans')).status).toBe(403);
  });

  test('10. vence la prueba: se bloquea todo, bot y campañas se frenan', async () => {
    await prisma.organization.update({ where: { id: ctx.org.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    billing.clearBlockedCache();
    expect((await ctx.admin.agent.get('/api/org/contacts')).status).toBe(402);
    expect((await ctx.ana.agent.get('/api/org/orders')).status).toBe(402);
    expect((await ctx.admin.agent.get('/api/org/billing/status')).body.access.state).toBe('expired');
    const camp = await prisma.campaign.create({ data: { organizationId: ctx.org.id, name: 'Pausar', message: 'x', status: 'SENDING', recipients: { create: [{ contactId: ctx.contact.id }] } } });
    await campaigns.processNext(ctx.org.id, camp.id);
    expect((await prisma.campaign.findUnique({ where: { id: camp.id } })).status).toBe('PAUSED');
    campaigns.clearAllTimers();
  });

  test('11. paga el plan Manager: se desbloquea, cupo de 5 agentes, y ya no hay 402', async () => {
    const payment = await prisma.billingPayment.create({ data: { organizationId: ctx.org.id, amount: 160000, planId: 'plan-manager', planName: 'Manager', winsapLinkId: '77', paymentUrl: 'https://winsap.test/pay/x' } });
    const body = JSON.stringify({ event: 'payment.paid', data: { id: 900, reference: payment.id, status: 'paid', payment_method: 'Bancard Tpago' } });
    const hook = await request(app).post('/api/billing/webhook/winsap').set('Content-Type', 'application/json').set('X-Winsap-Signature', sign(body)).send(body);
    expect(hook.status).toBe(200);
    expect((await ctx.admin.agent.get('/api/org/contacts')).status).toBe(200);
    const st = await ctx.admin.agent.get('/api/org/billing/status');
    expect(st.body.access.state).toBe('active');
    expect(st.body.seats).toMatchObject({ planName: 'Manager', maxAgents: 5 });
    for (let i = 2; i <= 5; i += 1) {
      expect((await post(ctx.admin, '/api/org/users', { name: `Agente ${i}`, email: `ag${i}@journey.test`, role: 'AGENT' })).status).toBe(201);
    }
    const over = await post(ctx.admin, '/api/org/users', { name: 'Agente 6', email: 'ag6@journey.test', role: 'AGENT' });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/Manager/);
  });
});
