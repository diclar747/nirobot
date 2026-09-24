const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');
const sms = require('../src/lib/sms');

beforeEach(async () => {
  await resetDb();
  jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected', qr: null, phone: '595980000000' });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

async function setup(suffix = '') {
  const org = await createOrganization(prisma, { slug: `api-full${suffix}` });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner${suffix}@apifull.test`, role: 'OWNER' });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  const created = await agent.post('/api/org/api-keys').set('X-CSRF-Token', csrfToken).send({ name: 'ERP' });
  return { org, owner, secret: created.body.secret, agent, csrfToken };
}
const withKey = (secret, req) => req.set('Authorization', `Bearer ${secret}`);

describe('API pública completa', () => {
  test('/me informa permisos y si WhatsApp está conectado', async () => {
    const { secret, org } = await setup();
    const res = await withKey(secret, request(app).get('/api/v1/me'));
    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(org.id);
    expect(res.body.whatsapp.connected).toBe(true);
    expect(res.body.scopes).toEqual(expect.arrayContaining(['messages:send', 'sms:send', 'webhooks:manage']));
  });

  test('contactos: alta, repetido no duplica, y búsqueda', async () => {
    const { secret } = await setup('-c');
    const creado = await withKey(secret, request(app).post('/api/v1/contacts')).send({ name: 'Ana', phone: '+595 981 234 567', tags: ['vip'] });
    expect(creado.status).toBe(201);
    expect(creado.body.contact.phone).toBe('595981234567');

    const repetido = await withKey(secret, request(app).post('/api/v1/contacts')).send({ phone: '595981234567', name: 'Ana Gómez' });
    expect(repetido.status).toBe(200);
    expect(repetido.body.created).toBe(false);

    const lista = await withKey(secret, request(app).get('/api/v1/contacts?search=Ana'));
    expect(lista.body.contacts).toHaveLength(1);
    expect(lista.body.contacts[0].name).toBe('Ana Gómez');
  });

  test('conversaciones: listar, ver el historial y cambiar el estado', async () => {
    const { secret, org } = await setup('-conv');
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000111' } });
    const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', status: 'OPEN' } });
    await prisma.message.create({ data: { conversationId: conversation.id, direction: 'INBOUND', content: 'Hola, consulta' } });

    const lista = await withKey(secret, request(app).get('/api/v1/conversations?status=OPEN'));
    expect(lista.body.conversations).toHaveLength(1);

    const detalle = await withKey(secret, request(app).get(`/api/v1/conversations/${conversation.id}`));
    expect(detalle.body.messages[0].content).toBe('Hola, consulta');

    const cerrada = await withKey(secret, request(app).patch(`/api/v1/conversations/${conversation.id}`)).send({ status: 'CLOSED', tags: ['Cerradas'] });
    expect(cerrada.status).toBe(200);
    expect(cerrada.body.conversation.status).toBe('CLOSED');
    expect((await prisma.conversation.findUnique({ where: { id: conversation.id } })).tags).toContain('Cerradas');
  });

  test('recibir consultando: /messages trae lo nuevo desde una fecha', async () => {
    const { secret, org } = await setup('-msg');
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000222' } });
    const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp' } });
    const viejo = new Date(Date.now() - 3600000);
    await prisma.message.create({ data: { conversationId: conversation.id, direction: 'INBOUND', content: 'viejo', createdAt: viejo } });
    await prisma.message.create({ data: { conversationId: conversation.id, direction: 'INBOUND', content: 'nuevo' } });

    const todos = await withKey(secret, request(app).get('/api/v1/messages?direction=INBOUND'));
    expect(todos.body.messages.map((m) => m.content)).toEqual(['viejo', 'nuevo']);

    const desde = await withKey(secret, request(app).get(`/api/v1/messages?since=${viejo.toISOString()}`));
    expect(desde.body.messages.map((m) => m.content)).toEqual(['nuevo']);
    expect(desde.body.nextSince).toBeTruthy();
  });

  test('SMS: saldo, envío y consulta del resultado', async () => {
    const { secret, org } = await setup('-sms');
    await prisma.organization.update({ where: { id: org.id }, data: { smsBalance: 50 } });
    jest.spyOn(sms, 'startCampaign').mockResolvedValue(undefined);

    const saldo = await withKey(secret, request(app).get('/api/v1/sms/balance'));
    expect(saldo.status).toBe(200);
    expect(saldo.body.balance).toBe(50);

    const envio = await withKey(secret, request(app).post('/api/v1/sms')).send({ to: ['0985768793', '0981222333'], message: 'Tu pedido esta listo' });
    expect(envio.status).toBe(201);
    expect(envio.body.recipients).toBe(2);

    const detalle = await withKey(secret, request(app).get(`/api/v1/sms/${envio.body.id}`));
    expect(detalle.status).toBe(200);
    expect(detalle.body.messages).toHaveLength(2);
  });

  test('SMS: avisa cuando el número no sirve o no hay saldo', async () => {
    const { secret } = await setup('-sms2');
    const invalido = await withKey(secret, request(app).post('/api/v1/sms')).send({ to: '12345', message: 'hola' });
    expect(invalido.status).toBe(400);

    // Sin saldo la API responde 402 (pago requerido), no 400.
    const sinSaldo = await withKey(secret, request(app).post('/api/v1/sms')).send({ to: '0985768793', message: 'hola' });
    expect(sinSaldo.status).toBe(402);
  });

  test('webhooks: registrar, listar, firmar el aviso y eliminar', async () => {
    const { secret, org } = await setup('-wh');
    const creado = await withKey(secret, request(app).post('/api/v1/webhooks')).send({
      url: 'https://mi-sistema.test/niro', events: ['message.received', 'message.status']
    });
    expect(creado.status).toBe(201);
    expect(creado.body.webhook.secret).toMatch(/^whsec_/);

    const lista = await withKey(secret, request(app).get('/api/v1/webhooks'));
    expect(lista.body.webhooks).toHaveLength(1);
    expect(lista.body.webhooks[0].secret).toBeUndefined(); // el secreto se muestra una sola vez
    expect(lista.body.events).toEqual(expect.arrayContaining(['message.received']));

    // Un mensaje entrante dispara el aviso firmado.
    const enviados = [];
    const original = global.fetch;
    global.fetch = async (url, init) => { enviados.push({ url, init }); return { ok: true, status: 200 }; };
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000333' } });
    const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp' } });
    const message = await prisma.message.create({ data: { conversationId: conversation.id, direction: 'INBOUND', content: 'Hola' }, include: require('../src/lib/conversations').MESSAGE_INCLUDE });
    require('../src/lib/conversations').broadcastMessage(org.id, conversation.id, message);
    await new Promise((resolve) => setTimeout(resolve, 150));
    global.fetch = original;

    expect(enviados).toHaveLength(1);
    expect(enviados[0].url).toBe('https://mi-sistema.test/niro');
    expect(enviados[0].init.headers['X-Niro-Event']).toBe('message.received');
    const { sign } = require('../src/lib/apiWebhooks');
    const esperada = `sha256=${sign(creado.body.webhook.secret, enviados[0].init.body, enviados[0].init.headers['X-Niro-Timestamp'])}`;
    expect(enviados[0].init.headers['X-Niro-Signature']).toBe(esperada);

    const borrado = await withKey(secret, request(app).delete(`/api/v1/webhooks/${creado.body.webhook.id}`));
    expect(borrado.status).toBe(204);
    expect(await prisma.apiWebhook.count()).toBe(0);
  });

  test('una clave no puede ver datos de otra empresa', async () => {
    const a = await setup('-a');
    const b = await setup('-b');
    const contact = await prisma.contact.create({ data: { organizationId: b.org.id, name: 'Ajeno', phone: '595981999999' } });
    const conversation = await prisma.conversation.create({ data: { organizationId: b.org.id, contactId: contact.id, channel: 'whatsapp' } });
    const res = await withKey(a.secret, request(app).get(`/api/v1/conversations/${conversation.id}`));
    expect(res.status).toBe(404);
    const lista = await withKey(a.secret, request(app).get('/api/v1/contacts'));
    expect(lista.body.contacts).toHaveLength(0);
  });
});
