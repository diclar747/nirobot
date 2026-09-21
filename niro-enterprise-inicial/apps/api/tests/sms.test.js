const crypto = require('crypto');
const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const provider = require('../src/lib/smsProvider');
const billing = require('../src/lib/billing');
const smsText = require('../src/lib/smsText');
const sms = require('../src/lib/sms');

process.env.WINSAP_SMS_API_KEY = 'test-key';
process.env.SMS_SEND_DELAY_MS = '0';
process.env.PUBLIC_APP_URL = 'https://app.test';

let org, other, owner, supervisor, agent, ownerS, supS, agentS, superS;
const send = (s, method, path, body) => s.agent[method](path).set('X-CSRF-Token', s.csrfToken).send(body);
const get = (s, path) => s.agent.get(path);
const waitFor = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('tiempo agotado esperando el envío'); };
const balance = async () => (await prisma.organization.findUnique({ where: { id: org.id } })).smsBalance;
const setBalance = (n) => prisma.organization.update({ where: { id: org.id }, data: { smsBalance: n } });
const finished = (id) => waitFor(async () => { const c = await prisma.smsCampaign.findUnique({ where: { id } }); return ['COMPLETED', 'PAUSED', 'CANCELLED'].includes(c.status) ? c : null; });

beforeAll(async () => {
  await resetDb();
  org = await createOrganization(prisma, { slug: `sms-${Date.now()}` });
  other = await createOrganization(prisma, { slug: `sms2-${Date.now()}` });
  for (const o of [org, other]) await prisma.organization.update({ where: { id: o.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@sms.test`, role: 'OWNER' });
  supervisor = await createUser(prisma, { organizationId: org.id, email: `s${Date.now()}@sms.test`, role: 'SUPERVISOR' });
  agent = await createUser(prisma, { organizationId: org.id, email: `a${Date.now()}@sms.test`, role: 'AGENT' });
  const root = await createUser(prisma, { organizationId: null, email: `root${Date.now()}@sms.test`, role: 'SUPERADMIN' });
  [ownerS, supS, agentS, superS] = [await loginAgent(app, owner.email), await loginAgent(app, supervisor.email), await loginAgent(app, agent.email), await loginAgent(app, root.email)];
});
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  await prisma.smsMessage.deleteMany({}); await prisma.smsCampaign.deleteMany({}); await prisma.smsPurchase.deleteMany({}); await prisma.smsTransaction.deleteMany({});
  await prisma.contact.deleteMany({});
  await setBalance(0);
});
const mockProvider = () => jest.spyOn(provider, 'sendSms').mockImplementation(async ({ to }) => ({ messageId: `wsp_${to}`, segments: 1, encoding: 'gsm7', cost: 1, remaining: 99 }));
const newCampaign = (over = {}) => ({ name: 'Promo', message: 'Hola {nombre}, tenemos una oferta para vos', recipients: [{ name: 'Ana', phone: '0985768793' }, { name: 'Beto', phone: '985111222' }], ...over });

describe('Reglas de números y texto', () => {
  test('los números de Paraguay se normalizan siempre a 595…', () => {
    for (const v of ['0985768793', '985768793', '595985768793', '+595 985 768 793', '(0985) 768-793', '5950985768793']) expect(smsText.normalizePyPhone(v)).toBe('595985768793');
    for (const v of ['12345', '021 123 456', '+5491155555555', '', null, '098576879']) expect(smsText.normalizePyPhone(v)).toBeNull();
  });
  test('límite de 160 caracteres; con tildes sin quitar baja a 70', () => {
    expect(smsText.analyzeText('a'.repeat(160)).fits).toBe(true);
    expect(smsText.analyzeText('a'.repeat(161)).fits).toBe(false);
    const accented = smsText.analyzeText('Promoción ñandú '.repeat(3), { stripAccents: false });
    expect(accented).toMatchObject({ encoding: 'ucs2', limit: 70 });
    const stripped = smsText.analyzeText('Promoción ñandú '.repeat(3), { stripAccents: true });
    expect(stripped).toMatchObject({ encoding: 'gsm7', limit: 160, text: expect.stringContaining('Promocion nandu') });
  });
  test('lee listas pegadas: nombre,número · número · sin repetidos ni inválidos', () => {
    const rows = smsText.parseRecipientList('nombre,numero\nJuan Pérez,0985768793\n0981111222\n+595 971 222 333;Ana\nMaría 0972-333-444\nabc\n0985768793');
    expect(rows.filter((r) => r.valid).map((r) => [r.name, r.phone])).toEqual([['Juan Pérez', '595985768793'], [null, '595981111222'], ['Ana', '595971222333'], ['María', '595972333444']]);
    expect(rows.filter((r) => !r.valid).map((r) => r.reason)).toEqual(['No tiene un número de teléfono', 'Número repetido']);
  });
});

describe('Campañas y saldo', () => {
  test('sin saldo suficiente no sale y dice cuánto falta; con saldo envía y descuenta 1 por SMS', async () => {
    const sendSms = mockProvider();
    await setBalance(1);
    const denied = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ startNow: true }));
    expect(denied.status).toBe(402);
    expect(denied.body).toMatchObject({ code: 'SMS_INSUFFICIENT_BALANCE', data: { required: 2, balance: 1, missing: 1 } });
    expect(sendSms).not.toHaveBeenCalled();
    const draftId = denied.body.data.campaignId;
    expect((await prisma.smsCampaign.findUnique({ where: { id: draftId } })).status).toBe('DRAFT'); // queda guardada

    await setBalance(2);
    const started = await send(ownerS, 'post', `/api/org/sms/campaigns/${draftId}/start`, {});
    expect(started.status).toBe(200);
    const done = await finished(draftId);
    expect(done.status).toBe('COMPLETED');
    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(sendSms.mock.calls.map(([a]) => a.to).sort()).toEqual(['595111222'.padStart(12, '5959'.slice(0, 0)) && '595985111222', '595985768793'].sort());
    expect(sendSms.mock.calls.find(([a]) => a.to === '595985768793')[0].message).toBe('Hola Ana, tenemos una oferta para vos'); // {nombre} personalizado
    expect(await balance()).toBe(0);
    const tx = await prisma.smsTransaction.findMany({ orderBy: { createdAt: 'asc' } });
    expect(tx.map((t) => [t.type, t.amount])).toEqual([['CONSUMPTION', -1], ['CONSUMPTION', -1]]);
    expect(tx[1].balanceAfter).toBe(0);
  });

  test('mensaje de más de 160 caracteres, o que se pasa al reemplazar el nombre, se rechaza', async () => {
    expect((await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ message: 'x'.repeat(161) }))).status).toBe(400);
    const res = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ message: `${'x'.repeat(152)}{nombre}`, recipients: [{ name: 'Al', phone: '0985768793' }, { name: 'Bartolomé Maximiliano', phone: '0985111222' }] }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SMS_TOO_LONG');
    expect(await prisma.smsCampaign.count()).toBe(0);
  });

  test('números inválidos se descartan; si ninguno sirve, error', async () => {
    const ok = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ recipients: [{ phone: '0985768793' }, { phone: '12345' }, { phone: '0985 768 793' }] }));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ recipients: 1, invalid: 1 });
    expect((await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ recipients: [{ phone: '123' }] }))).status).toBe(400);
  });

  test('si el proveedor rechaza un SMS se devuelve el crédito y queda como fallido', async () => {
    jest.spyOn(provider, 'sendSms').mockImplementation(async ({ to }) => { if (to.endsWith('111222')) throw new provider.SmsProviderError('Número inválido', { status: 400 }); return { messageId: 'ok1' }; });
    await setBalance(2);
    const res = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ startNow: true }));
    expect(res.status).toBe(201);
    await finished(res.body.campaign.id);
    const rows = await prisma.smsMessage.findMany({ orderBy: { phone: 'asc' } });
    expect(rows.map((r) => r.status).sort()).toEqual(['FAILED', 'SENT']);
    expect(rows.find((r) => r.status === 'FAILED').errorMessage).toMatch(/inválido/);
    expect(await balance()).toBe(1); // solo se cobró el que salió
    expect((await prisma.smsTransaction.findMany()).map((t) => t.type).sort()).toEqual(['CONSUMPTION', 'CONSUMPTION', 'REFUND']);
  });

  test('si el proveedor no tiene saldo la campaña se pausa, sin cobrar ni perder mensajes', async () => {
    jest.spyOn(provider, 'sendSms').mockRejectedValue(new provider.SmsProviderError('Saldo insuficiente', { status: 402, outOfCredit: true }));
    await setBalance(5);
    const res = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ startNow: true }));
    const campaign = await finished(res.body.campaign.id);
    expect(campaign.status).toBe('PAUSED');
    expect(campaign.pauseReason).toMatch(/sin saldo/i);
    expect(await balance()).toBe(5);
    expect(await prisma.smsMessage.count({ where: { status: 'PENDING' } })).toBe(2);
  });

  test('envío rápido, pausa/cancelación, editar, duplicar y eliminar', async () => {
    const sendSms = mockProvider();
    await setBalance(10);
    const quick = await send(ownerS, 'post', '/api/org/sms/send', { message: 'Aviso importante', recipients: [{ phone: '0985768793' }] });
    expect(quick.status).toBe(201);
    expect(quick.body.campaign.source).toBe('QUICK');
    await finished(quick.body.campaign.id);
    expect(sendSms).toHaveBeenCalledTimes(1);

    const draft = (await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign())).body.campaign;
    const edited = await send(ownerS, 'patch', `/api/org/sms/campaigns/${draft.id}`, newCampaign({ name: 'Editada', message: 'Otro texto', recipients: [{ phone: '0971000111' }] }));
    expect(edited.status).toBe(200);
    expect(edited.body.campaign).toMatchObject({ name: 'Editada', counts: { total: 1 } });
    expect(await prisma.smsCampaign.findUnique({ where: { id: draft.id } })).toBeNull();
    const config = await get(ownerS, `/api/org/sms/campaigns/${edited.body.campaign.id}/config`);
    expect(config.body.recipients.map((r) => r.phone)).toEqual(['595971000111']);

    const cancelled = await send(ownerS, 'post', `/api/org/sms/campaigns/${edited.body.campaign.id}/cancel`, {});
    expect(cancelled.body.campaign.status).toBe('CANCELLED');
    expect((await send(ownerS, 'delete', `/api/org/sms/campaigns/${edited.body.campaign.id}`, {})).status).toBe(200);
    const more = (await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign())).body.campaign;
    const bulk = await send(ownerS, 'post', '/api/org/sms/campaigns/bulk-delete', { ids: [more.id, quick.body.campaign.id] });
    expect(bulk.body.deleted).toHaveLength(2);
  });

  test('crear una campaña NO la envía: queda en borrador hasta que se toca Enviar', async () => {
    const sendSms = mockProvider(); await setBalance(10);
    const res = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign());
    expect(res.status).toBe(201);
    expect(res.body.campaign).toMatchObject({ status: 'DRAFT', counts: { total: 2, pending: 2, ok: 0 } });
    await new Promise((r) => setTimeout(r, 200));
    expect(sendSms).not.toHaveBeenCalled();
    expect(await balance()).toBe(10);
    expect((await send(ownerS, 'post', `/api/org/sms/campaigns/${res.body.campaign.id}/start`, {})).status).toBe(200);
    await finished(res.body.campaign.id);
    expect(sendSms).toHaveBeenCalledTimes(2);
  });

  test('detener, editar el texto de lo que falta y reanudar; lo ya enviado no cambia', async () => {
    let calls = 0;
    const gate = { release: null };
    jest.spyOn(provider, 'sendSms').mockImplementation(async ({ to, message }) => { calls += 1; if (calls === 2) await new Promise((r) => { gate.release = r; }); return { messageId: `m_${to}`, message }; });
    await setBalance(10);
    const created = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ recipients: [{ name: 'Ana', phone: '0985100001' }, { name: 'Beto', phone: '0985100002' }, { name: 'Carla', phone: '0985100003' }] }));
    const id = created.body.campaign.id;
    await send(ownerS, 'post', `/api/org/sms/campaigns/${id}/start`, {});
    await waitFor(async () => calls === 2);                      // el primero salió y el segundo está en vuelo
    const paused = await send(ownerS, 'post', `/api/org/sms/campaigns/${id}/pause`, {});
    expect(paused.body.campaign.status).toBe('PAUSED');
    gate.release();
    await finished(id);
    const sentBefore = await prisma.smsMessage.findMany({ where: { campaignId: id, status: 'SENT' } });
    const edited = await send(ownerS, 'patch', `/api/org/sms/campaigns/${id}`, { name: 'Corregida', message: 'Texto corregido para {nombre}', stripAccents: true });
    expect(edited.status).toBe(200);
    expect(edited.body.campaign).toMatchObject({ name: 'Corregida', message: 'Texto corregido para {nombre}', status: 'PAUSED' });
    const pendingRows = await prisma.smsMessage.findMany({ where: { campaignId: id, status: 'PENDING' } });
    expect(pendingRows.every((m) => m.body.startsWith('Texto corregido para '))).toBe(true);
    expect((await prisma.smsMessage.findMany({ where: { campaignId: id, status: 'SENT' } })).map((m) => m.body)).toEqual(sentBefore.map((m) => m.body)); // intactos
    expect((await send(ownerS, 'patch', `/api/org/sms/campaigns/${id}`, { name: 'x', message: 'z'.repeat(170), stripAccents: true })).status).toBe(400);
    const resumed = await send(ownerS, 'post', `/api/org/sms/campaigns/${id}/resume`, {});
    expect(resumed.status).toBe(200);
    await finished(id);
    expect((await prisma.smsCampaign.findUnique({ where: { id } })).status).toBe('COMPLETED');
    expect(calls).toBe(3);
  });

  test('reenviar los fallidos vuelve a intentarlos y cobra solo lo que sale', async () => {
    let fail = true;
    jest.spyOn(provider, 'sendSms').mockImplementation(async ({ to }) => { if (fail && to.endsWith('111222')) throw new provider.SmsProviderError('Rechazado', { status: 400 }); return { messageId: `m_${to}` }; });
    await setBalance(5);
    const created = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign());
    await send(ownerS, 'post', `/api/org/sms/campaigns/${created.body.campaign.id}/start`, {});
    await finished(created.body.campaign.id);
    expect(await balance()).toBe(4);
    expect((await send(ownerS, 'post', `/api/org/sms/campaigns/${created.body.campaign.id}/retry-failed`, {})).status).toBe(200);
    fail = false;
    await waitFor(async () => (await prisma.smsMessage.count({ where: { campaignId: created.body.campaign.id, status: 'SENT' } })) === 2);
    await finished(created.body.campaign.id);
    expect(await balance()).toBe(3);
    expect((await send(ownerS, 'post', `/api/org/sms/campaigns/${created.body.campaign.id}/retry-failed`, {})).status).toBe(409); // ya no hay fallidos
    await setBalance(0);
    const draft = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign());
    expect((await send(ownerS, 'post', `/api/org/sms/campaigns/${draft.body.campaign.id}/retry-failed`, {})).status).toBe(409); // todavía no salió
  });

  test('guarda en los contactos y usa los del CRM por etiqueta', async () => {
    mockProvider(); await setBalance(10);
    await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente VIP', phone: '595981333444', tags: ['vip'] } });
    await prisma.contact.create({ data: { organizationId: org.id, name: 'Sin SMS', phone: '021123456', tags: ['vip'] } });
    const res = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ recipients: [{ name: 'Nuevo', phone: '0972555666' }], tagFilter: ['vip'], saveToCrm: true }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ recipients: 2, invalid: 1 });
    expect((await prisma.contact.findFirst({ where: { organizationId: org.id, phone: '595972555666' } })).name).toBe('Nuevo');
    const audience = await get(ownerS, '/api/org/sms/audience');
    expect(audience.body.contacts.find((c) => c.name === 'Sin SMS').sms).toBeNull();
  });

  test('POST /parse-list lee lo pegado y resume válidos, inválidos y repetidos', async () => {
    const res = await send(ownerS, 'post', '/api/org/sms/parse-list', { text: 'Ana,0985768793\nBeto,985768793\nxx\n0981222333' });
    expect(res.body.summary).toEqual({ total: 4, valid: 2, invalid: 1, duplicates: 1 });
    expect(res.body.recipients).toEqual([{ name: 'Ana', phone: '595985768793' }, { name: null, phone: '595981222333' }]);
  });
});

describe('Recargas de saldo', () => {
  test('la compra usa el precio de 130 Gs. por SMS y crea el link de pago de Winsap', async () => {
    const winsap = jest.spyOn(billing, 'winsap').mockResolvedValue({ data: { id: 77, token: 'tok', payment_url: 'https://pay.test/x' } });
    const res = await send(ownerS, 'post', '/api/org/sms/purchases', { credits: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.purchase).toMatchObject({ credits: 1000, amount: 130000, unitPrice: 130, status: 'pending', paymentUrl: 'https://pay.test/x' });
    expect(winsap.mock.calls[0][2]).toMatchObject({ price: 130000, currency: 'PYG', webhook_url: 'https://app.test/api/billing/webhook/winsap-sms' });
    expect(winsap.mock.calls[0][2].reference).toBe(`sms:${res.body.purchase.id}`);
    expect((await send(ownerS, 'post', '/api/org/sms/purchases', { credits: 1000 })).body.purchase.id).toBe(res.body.purchase.id); // reutiliza el link pendiente
    for (const bad of [0, 50, 1.5, 'abc', 2000000]) expect((await send(ownerS, 'post', '/api/org/sms/purchases', { credits: bad })).status).toBe(400);
    expect((await send(supS, 'post', '/api/org/sms/purchases', { credits: 1000 })).status).toBe(403); // el supervisor no compra
  });

  test('el pago confirmado por el webhook firmado acredita el saldo una sola vez', async () => {
    jest.spyOn(billing, 'winsap').mockResolvedValue({ data: { id: 78, token: 't2', payment_url: 'https://pay.test/y' } });
    const purchase = (await send(ownerS, 'post', '/api/org/sms/purchases', { credits: 2500 })).body.purchase;
    const body = { event: 'payment.paid', data: { reference: `sms:${purchase.id}`, payment_id: 900, payment_method: 'card', status: 'paid' } };
    const raw = JSON.stringify(body);
    const signature = `sha256=${crypto.createHmac('sha256', billing.webhookSecret()).update(raw).digest('hex')}`;
    const hit = () => request(app).post('/api/billing/webhook/winsap-sms').set('Content-Type', 'application/json').set('x-winsap-signature', signature).send(raw);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200); // Winsap reintenta: no duplica
    expect(await balance()).toBe(2500);
    expect((await prisma.smsPurchase.findUnique({ where: { id: purchase.id } })).status).toBe('paid');
    expect((await prisma.smsTransaction.findMany()).map((t) => [t.type, t.amount])).toEqual([['PURCHASE', 2500]]);
    const bad = await request(app).post('/api/billing/webhook/winsap-sms').set('Content-Type', 'application/json').set('x-winsap-signature', 'sha256=falsa').send(raw);
    expect(bad.status).toBe(401);
  });

  test('"ya pagué" consulta a Winsap y acredita', async () => {
    const winsap = jest.spyOn(billing, 'winsap');
    winsap.mockResolvedValueOnce({ data: { id: 79, token: 't3', payment_url: 'https://pay.test/z' } });
    const purchase = (await send(ownerS, 'post', '/api/org/sms/purchases', { credits: 500 })).body.purchase;
    winsap.mockResolvedValueOnce({ data: [{ id: 1, reference: `sms:${purchase.id}`, payment_method: 'qr' }] });
    const res = await send(ownerS, 'post', '/api/org/sms/purchases/verify', {});
    expect(res.body).toEqual({ credited: 1, balance: 500 });
  });

  test('el superadmin asigna saldo a mano (queda en el historial de compras) y puede descontar sin pasar de cero', async () => {
    const res = await send(superS, 'post', `/api/superadmin/sms/organizations/${org.id}/credits`, { credits: 1000, note: 'Pagó por transferencia' });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(1000);
    const purchases = await get(ownerS, '/api/org/sms/purchases');
    expect(purchases.body.purchases[0]).toMatchObject({ credits: 1000, source: 'ADMIN', status: 'paid', amount: 130000, note: 'Pagó por transferencia' });
    expect((await send(superS, 'post', `/api/superadmin/sms/organizations/${org.id}/credits`, { credits: -400 })).body.balance).toBe(600);
    expect((await send(superS, 'post', `/api/superadmin/sms/organizations/${org.id}/credits`, { credits: -5000 })).status).toBe(402);
    expect((await send(ownerS, 'post', `/api/superadmin/sms/organizations/${org.id}/credits`, { credits: 10 })).status).toBe(403);
    const tx = await get(ownerS, '/api/org/sms/transactions');
    expect(tx.body.transactions.map((t) => [t.type, t.amount, t.balanceAfter])).toEqual([['ADJUSTMENT', -400, 600], ['PURCHASE', 1000, 1000]]);
  });
});

describe('Panel, historial y permisos', () => {
  test('el panel resume saldo, envíos por día y recargas', async () => {
    mockProvider(); await setBalance(5);
    const c = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ startNow: true }));
    await finished(c.body.campaign.id);
    const res = await get(ownerS, '/api/org/sms/overview');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ balance: 3, priceGs: 130, packages: [1000, 2500, 5000, 10000], providerReady: true, creditsUsed: 2 });
    expect(res.body.totals).toMatchObject({ ok: 2, failed: 0, total: 2 });
    expect(res.body.daily).toHaveLength(1);
    expect(res.body.recentCampaigns[0]).toMatchObject({ name: 'Promo', status: 'COMPLETED' });
  });

  test('historial con filtros por estado, número y fechas, y exportación CSV', async () => {
    jest.spyOn(provider, 'sendSms').mockImplementation(async ({ to }) => { if (to.endsWith('111222')) throw new provider.SmsProviderError('Rechazado', { status: 400 }); return { messageId: `m_${to}` }; });
    await setBalance(5);
    const c = await send(ownerS, 'post', '/api/org/sms/campaigns', newCampaign({ startNow: true }));
    await finished(c.body.campaign.id);
    expect((await get(ownerS, '/api/org/sms/messages')).body.total).toBe(2);
    expect((await get(ownerS, '/api/org/sms/messages?status=ok')).body.messages.map((m) => m.phone)).toEqual(['595985768793']);
    expect((await get(ownerS, '/api/org/sms/messages?status=failed')).body.messages[0]).toMatchObject({ phone: '595985111222', error: 'Rechazado' });
    expect((await get(ownerS, '/api/org/sms/messages?q=0985768793')).body.total).toBe(1);
    const future = encodeURIComponent(new Date(Date.now() + 86400000).toISOString());
    expect((await get(ownerS, `/api/org/sms/messages?from=${future}`)).body.total).toBe(0);
    const csv = await get(ownerS, '/api/org/sms/messages?format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')).toHaveLength(3);
  });

  test('un agente no accede; el supervisor envía; otra empresa no ve los datos', async () => {
    expect((await get(agentS, '/api/org/sms/overview')).status).toBe(403);
    mockProvider(); await setBalance(5);
    expect((await send(supS, 'post', '/api/org/sms/campaigns', newCampaign({ startNow: true }))).status).toBe(201);
    await waitFor(async () => (await prisma.smsMessage.count({ where: { status: 'SENT' } })) === 2);
    const foreign = await prisma.smsCampaign.create({ data: { organizationId: other.id, name: 'Ajena', message: 'x' } });
    expect((await get(ownerS, `/api/org/sms/campaigns/${foreign.id}`)).status).toBe(404);
    expect((await send(ownerS, 'post', `/api/org/sms/campaigns/${foreign.id}/start`, {})).status).toBe(404);
    expect((await get(ownerS, '/api/org/sms/campaigns')).body.campaigns.every((c) => c.name !== 'Ajena')).toBe(true);
  });

  test('el webhook de entrega marca entregado o fallido solo con el token correcto', async () => {
    const campaign = await prisma.smsCampaign.create({ data: { organizationId: org.id, name: 'W', message: 'x', status: 'COMPLETED' } });
    const msg = await prisma.smsMessage.create({ data: { organizationId: org.id, campaignId: campaign.id, phone: '595985768793', body: 'x', status: 'SENT', providerMessageId: 'wsp_abc' } });
    const url = (t) => `/api/billing/webhook/sms-delivery?token=${t}`;
    expect((await request(app).post(url('mal')).send({ message_id: 'wsp_abc', status: 'delivered' })).status).toBe(401);
    expect((await request(app).post(url(provider.webhookToken())).send({ message_id: 'wsp_abc', status: 'delivered' })).status).toBe(200);
    expect((await prisma.smsMessage.findUnique({ where: { id: msg.id } })).status).toBe('DELIVERED');
  });

  test('el superadmin ve el saldo del proveedor y el resumen por empresa', async () => {
    jest.spyOn(provider, 'getBalance').mockResolvedValue({ balance: 250, unitCost: 1, charLimit: 160 });
    await send(superS, 'post', `/api/superadmin/sms/organizations/${org.id}/credits`, { credits: 100 });
    const res = await get(superS, '/api/superadmin/sms/overview');
    expect(res.body.provider).toMatchObject({ configured: true, balance: 250 });
    expect(res.body.priceGs).toBe(130);
    expect(res.body.organizations.find((o) => o.id === org.id)).toMatchObject({ balance: 100, creditsAdmin: 100 });
    expect(res.body.totals.customerBalance).toBe(100);
  });
});
