const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const campaigns = require('../src/lib/campaigns');
const whatsapp = require('../src/lib/whatsapp');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

async function setup() {
  const organization = await createOrganization(prisma, { slug: 'campaigns-test' });
  const owner = await createUser(prisma, { organizationId: organization.id, email: 'owner@campaigns.test', role: 'OWNER' });
  const ana = await prisma.contact.create({ data: { organizationId: organization.id, name: 'Ana Test', phone: '595980000101', tags: ['crm', 'promo'] } });
  const bruno = await prisma.contact.create({ data: { organizationId: organization.id, name: 'Bruno Test', phone: '595980000102', tags: ['crm'] } });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { agent, csrfToken, ana, bruno, organization };
}

describe('Campañas de WhatsApp', () => {
  test('crea una campaña con audiencia mixta y perfil de velocidad', async () => {
    const { agent, csrfToken, ana, bruno } = await setup();
    const response = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({
      name: 'Promo QA',
      message: 'Hola ✨',
      tagFilter: ['crm'],
      contactIds: [ana.id],
      speedProfile: 'CONSERVATIVE',
      messagesPerHour: 10,
      campaignType: 'DIRECT'
    });

    expect(response.status).toBe(201);
    expect(response.body.campaign.status).toBe('DRAFT');
    expect(response.body.campaign.messagesPerHour).toBe(10);
    expect(response.body.campaign.counts.total).toBe(2);
    expect(response.body.campaign.counts.replies).toBe(0);
    void bruno;
  });

  test('programa una campaña y conserva sus destinatarios en el historial', async () => {
    const { agent, csrfToken, ana } = await setup();
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({
      name: 'Campaña programada QA',
      message: 'Recordatorio',
      contactIds: [ana.id],
      speedProfile: 'BALANCED',
      campaignType: 'SCHEDULED',
      scheduledAt
    });

    expect(response.status).toBe(201);
    expect(response.body.campaign.status).toBe('SCHEDULED');
    expect(response.body.campaign.campaignType).toBe('SCHEDULED');
    const detail = await agent.get(`/api/org/campaigns/${response.body.campaign.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.recipients).toHaveLength(1);
    expect(detail.body.recipients[0].contact.id).toBe(ana.id);
  });

  test('rechaza campañas sin audiencia válida', async () => {
    const { agent, csrfToken } = await setup();
    const response = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'Sin audiencia', message: 'Hola' });
    expect(response.status).toBe(400);
  });

  test('el endpoint de sesiones es seguro y la sincronización exige una sesión conectada', async () => {
    const { agent, csrfToken } = await setup();
    const sessions = await agent.get('/api/org/whatsapp/sessions');
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toEqual([]);
    const sync = await agent.post('/api/org/whatsapp/sync-contacts').set('X-CSRF-Token', csrfToken).send({});
    expect(sync.status).toBe(409);
  });

  test('acepta un archivo multimedia/documento antes de iniciar', async () => {
    const { agent, csrfToken, ana } = await setup();
    const created = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'Adjunto QA', message: 'Mirá el archivo', contactIds: [ana.id] });
    const response = await agent
      .post(`/api/org/campaigns/${created.body.campaign.id}/attachment`)
      .set('X-CSRF-Token', csrfToken)
      .attach('file', Buffer.from('archivo de prueba'), 'nota.txt');

    expect(response.status).toBe(200);
    expect(response.body.campaign.attachment.fileName).toBe('nota.txt');
    expect(response.body.campaign.attachment.mimeType).toBe('text/plain');
  });

  test('marca fallidos cuando se inicia sin WhatsApp conectado', async () => {
    const { agent, csrfToken, ana } = await setup();
    const created = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'Fallo QA', message: 'Prueba', contactIds: [ana.id], messagesPerHour: 100 });
    const started = await agent.post(`/api/org/campaigns/${created.body.campaign.id}/start`).set('X-CSRF-Token', csrfToken).send({});
    expect(started.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const detail = await agent.get(`/api/org/campaigns/${created.body.campaign.id}`);
    expect(detail.body.campaign.counts.failed).toBe(1);
    campaigns.clearAllTimers();
  });

  test('registra el envío en la conversación y actualiza entregado/visto', async () => {
    const { agent, csrfToken, ana, organization } = await setup();
    const response = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({
      name: 'Historial QA',
      message: 'Mensaje trazable',
      contactIds: [ana.id],
      speedProfile: 'HIGH_PERFORMANCE',
      messagesPerHour: 100
    });
    const campaignId = response.body.campaign.id;
    const sendTextSpy = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('wa-campaign-qa');

    await campaigns.startCampaign(organization.id, campaignId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sentRecipient = await prisma.campaignRecipient.findFirst({ where: { campaignId } });
    expect(sentRecipient.status).toBe('SENT');
    const sentMessage = await prisma.message.findFirst({ where: { campaignId } });
    expect(sentMessage.content).toBe('Mensaje trazable');
    expect(sentMessage.waMessageId).toBe('wa-campaign-qa');

    await campaigns.handleDeliveryUpdate('wa-campaign-qa', 4);
    const readRecipient = await prisma.campaignRecipient.findUnique({ where: { id: sentRecipient.id } });
    const readMessage = await prisma.message.findUnique({ where: { id: sentMessage.id } });
    expect(readRecipient.status).toBe('READ');
    expect(readMessage.deliveryStatus).toBe('read');
    expect((await campaigns.getCounts(campaignId)).read).toBe(1);

    campaigns.clearAllTimers();
    sendTextSpy.mockRestore();
  });

  test('personaliza el mensaje por destinatario y conserva el texto renderizado en el historial', async () => {
    const { agent, csrfToken, ana, organization } = await setup();
    expect(campaigns.personalizeCampaignMessage('Hola {{nombre}}, tu teléfono es {{telefono}}.', ana)).toBe('Hola Ana, tu teléfono es 595980000101.');
    expect(campaigns.personalizeCampaignMessage('Hola {{nombre}}, tu teléfono es {{telefono}}.', { name: 'Bruno Test', phone: '595980000102' })).toBe('Hola Bruno, tu teléfono es 595980000102.');
    const response = await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({
      name: 'Personalización QA',
      message: 'Hola {{nombre}}, tu teléfono es {{telefono}}.',
      contactIds: [ana.id],
      messagesPerHour: 100
    });
    const campaignId = response.body.campaign.id;
    const sendTextSpy = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('wa-personalized-ana');

    await campaigns.startCampaign(organization.id, campaignId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sendTextSpy).toHaveBeenCalledWith(organization.id, ana.phone, 'Hola Ana, tu teléfono es 595980000101.');
    const messages = await prisma.message.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } });
    expect(messages.map((message) => message.content)).toEqual(['Hola Ana, tu teléfono es 595980000101.']);

    campaigns.clearAllTimers();
    sendTextSpy.mockRestore();
  });

  test('genera una API key de una sola lectura, envía por Bearer y revoca el acceso', async () => {
    const { agent, csrfToken, ana } = await setup();
    const created = await agent.post('/api/org/api-keys').set('X-CSRF-Token', csrfToken).send({ name: 'ERP QA' });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^nr_live_/);
    expect(created.body.apiKey.keyPrefix).toBe(created.body.secret.slice(0, 16));

    const getStatusSpy = jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected', qr: null, phone: '595980000000' });
    const sendTextSpy = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('wa-api-text-qa');
    const sent = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${created.body.secret}`)
      .send({ to: ana.phone, type: 'text', text: 'Hola desde API 👋' });

    expect(sent.status).toBe(201);
    expect(sent.body.waMessageId).toBe('wa-api-text-qa');
    expect(sent.body.message.content).toBe('Hola desde API 👋');
    const storedMessage = await prisma.message.findUnique({ where: { id: sent.body.id } });
    expect(storedMessage.apiKeyId).toBe(created.body.apiKey.id);

    const listed = await agent.get('/api/org/api-keys');
    expect(listed.status).toBe(200);
    expect(listed.body.apiKeys[0].keyPrefix).toBe(created.body.apiKey.keyPrefix);
    expect(JSON.stringify(listed.body.apiKeys)).not.toContain(created.body.secret);

    const revoked = await agent.delete(`/api/org/api-keys/${created.body.apiKey.id}`).set('X-CSRF-Token', csrfToken);
    expect(revoked.status).toBe(204);
    const rejected = await request(app).get('/api/v1/sessions').set('Authorization', `Bearer ${created.body.secret}`);
    expect(rejected.status).toBe(401);

    getStatusSpy.mockRestore();
    sendTextSpy.mockRestore();
  });

  test('envía todos los tipos multimedia de la API con multipart', async () => {
    const { agent, csrfToken, ana } = await setup();
    const created = await agent.post('/api/org/api-keys').set('X-CSRF-Token', csrfToken).send({ name: 'Media QA' });
    const getStatusSpy = jest.spyOn(whatsapp, 'getStatus').mockReturnValue({ status: 'connected', qr: null, phone: '595980000000' });
    const sendMediaSpy = jest.spyOn(whatsapp, 'sendMedia').mockImplementation(async (_organizationId, _phone, opts) => `wa-api-${opts.kind}`);
    const media = [
      ['image', 'image/jpeg', 'foto.jpg'],
      ['video', 'video/mp4', 'video.mp4'],
      ['audio', 'audio/ogg', 'audio.ogg'],
      ['document', 'application/pdf', 'documento.pdf'],
      ['sticker', 'image/webp', 'sticker.webp']
    ];

    for (const [type, mimeType, fileName] of media) {
      const response = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${created.body.secret}`)
        .field('to', ana.phone)
        .field('type', type)
        .field('text', `Contenido ${type}`)
        .field('caption', `Caption ${type}`)
        .field('ptt', type === 'audio' ? 'true' : 'false')
        .attach('file', Buffer.from(`fake-${type}`), { filename: fileName, contentType: mimeType });
      expect(response.status).toBe(201);
      expect(response.body.type).toBe(type);
      expect(response.body.status).toBe('sent');
    }
    expect(sendMediaSpy).toHaveBeenCalledTimes(media.length);
    expect(sendMediaSpy.mock.calls.find((call) => call[2].kind === 'sticker')[2].mimetype).toBe('image/webp');
    expect(sendMediaSpy.mock.calls.find((call) => call[2].kind === 'audio')[2].ptt).toBe(true);

    getStatusSpy.mockRestore();
    sendMediaSpy.mockRestore();
  });

  test('publica el contrato OpenAPI sin exponer credenciales', async () => {
    const docs = await request(app).get('/api/v1/openapi.json');
    expect(docs.status).toBe(200);
    expect(docs.body.openapi).toBe('3.0.3');
    expect(docs.body.paths['/messages'].post).toBeDefined();
    expect(docs.body.components.securitySchemes.bearerAuth).toBeDefined();
  });
});
