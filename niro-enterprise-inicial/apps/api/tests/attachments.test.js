const request = require('supertest');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

describe('Adjuntos (interno)', () => {
  test('sube una imagen a una conversación y queda disponible para descargar', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const conv = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'Cliente' } });
    const conversationId = conv.body.conversation.id;

    const res = await agent
      .post(`/api/org/conversations/${conversationId}/attachments`)
      .set('X-CSRF-Token', csrfToken)
      .field('content', 'foto adjunta')
      .attach('file', PNG_BUFFER, { filename: 'foto.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.message.attachment).toBeTruthy();
    expect(res.body.message.attachment.fileName).toBe('foto.png');
    expect(res.body.message.attachment.mimeType).toBe('image/png');
    expect(res.body.message.contentType).toBe('attachment');

    const download = await agent.get(`/api/org/conversations/${conversationId}/attachments/${res.body.message.attachment.id}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(download.body, PNG_BUFFER)).toBe(0);
  });

  test('rechaza tipos de archivo no permitidos', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const conv = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'Cliente' } });
    const conversationId = conv.body.conversation.id;

    const res = await agent
      .post(`/api/org/conversations/${conversationId}/attachments`)
      .set('X-CSRF-Token', csrfToken)
      .attach('file', Buffer.from('#!/bin/sh\necho hola'), { filename: 'script.sh', contentType: 'application/x-sh' });

    expect(res.status).toBe(400);
  });

  test('aislamiento: un adjunto de otra organización no se puede descargar', async () => {
    const orgA = await createOrganization(prisma, { slug: 'org-a' });
    const orgB = await createOrganization(prisma, { slug: 'org-b' });
    const ownerA = await createUser(prisma, { organizationId: orgA.id, email: 'owner@org-a.test', role: 'OWNER' });
    const ownerB = await createUser(prisma, { organizationId: orgB.id, email: 'owner@org-b.test', role: 'OWNER' });

    const { agent: agentB, csrfToken: csrfB } = await loginAgent(app, ownerB.email);
    const convB = await agentB.post('/api/org/conversations').set('X-CSRF-Token', csrfB).send({ newContact: { name: 'Cliente B' } });
    const uploadB = await agentB
      .post(`/api/org/conversations/${convB.body.conversation.id}/attachments`)
      .set('X-CSRF-Token', csrfB)
      .attach('file', PNG_BUFFER, { filename: 'foto.png', contentType: 'image/png' });

    const { agent: agentA } = await loginAgent(app, ownerA.email);
    const res = await agentA.get(`/api/org/conversations/${convB.body.conversation.id}/attachments/${uploadB.body.message.attachment.id}`);
    expect(res.status).toBe(404);
  });
});

describe('Adjuntos (widget)', () => {
  test('un visitante puede subir una imagen y el agente la ve; una nota con adjunto no es descargable desde el widget', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });

    const start = await request(app).post('/api/public/widget/acme/start').send({ name: 'Visitante' });
    const token = start.body.token;

    const upload = await request(app)
      .post('/api/public/widget/acme/attachments')
      .field('token', token)
      .attach('file', PNG_BUFFER, { filename: 'foto.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.message.direction).toBe('INBOUND');

    const download = await request(app).get(
      `/api/public/widget/acme/attachments/${upload.body.message.attachment.id}?token=${token}`
    );
    expect(download.status).toBe(200);

    const { agent, csrfToken } = await loginAgent(app, owner.email);
    const noteRes = await agent
      .post(`/api/org/conversations/${start.body.conversation.id}/attachments`)
      .set('X-CSRF-Token', csrfToken)
      .field('type', 'note')
      .attach('file', PNG_BUFFER, { filename: 'nota-interna.png', contentType: 'image/png' });

    const blocked = await request(app).get(
      `/api/public/widget/acme/attachments/${noteRes.body.message.attachment.id}?token=${token}`
    );
    expect(blocked.status).toBe(404);
  });
});
