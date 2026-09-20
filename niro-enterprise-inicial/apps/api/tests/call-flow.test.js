const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const calls = require('../src/lib/callCampaigns');
const request = require('supertest');
beforeEach(async () => { process.env.WHATSAPP_CALL_PROVIDER = 'mock'; await resetDb(); });
afterAll(async () => { await calls.shutdown(); delete process.env.WHATSAPP_CALL_PROVIDER; await resetDb(); await prisma.$disconnect(); });
test('direct call: authenticated start, audio ownership, hangup, history and next call', async () => {
  const org = await createOrganization(prisma, { slug: 'call-flow' });
  const user = await createUser(prisma, { organizationId: org.id, email: 'owner@calls.test', role: 'OWNER' });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Prueba', phone: '595991000111' } });
  const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp' } });
  await prisma.callAccount.create({ data: { organizationId: org.id, name: 'Prueba', sessionReference: 'mock', status: 'CONNECTED' } });
  const { agent, csrfToken } = await loginAgent(app, user.email);
  const start = () => agent.post('/api/org/wa-calls/direct').set('X-CSRF-Token', csrfToken).send({ conversationId: conversation.id });
  expect((await request(app).post('/api/org/wa-calls/direct').send({ conversationId: conversation.id })).status).toBe(401);
  const first = await start(); expect(first.status).toBe(202);
  const call = first.body.call;
  expect(call.audioToken).toHaveLength(64);
  expect((await start()).status).toBe(409);
  const emit = jest.fn(); const socket = { id: 'test-socket', connected: true, volatile: { emit }, emit };
  const auth = { organizationId: org.id, userId: user.id };
  expect(calls.bindDirectAudio({ ...auth, organizationId: 'other' }, call.id, call.audioToken, socket)).toBeNull();
  expect(calls.bindDirectAudio({ ...auth, userId: 'other' }, call.id, call.audioToken, socket)).toBeNull();
  expect(calls.bindDirectAudio(auth, call.id, 'x'.repeat(64), socket)).toBeNull();
  const binding = calls.bindDirectAudio(auth, call.id, call.audioToken, socket); expect(binding).toBeTruthy();
  binding.push(new Float32Array(320).fill(0.25)); expect(emit).toHaveBeenCalledWith('wa-call:audio', expect.objectContaining({ id: call.id }));
  expect((await agent.get(`/api/org/wa-calls/direct/${call.id}`)).body.call.audioToken).toBeUndefined();
  const hangup = await agent.post(`/api/org/wa-calls/direct/${call.id}/hangup`).set('X-CSRF-Token', csrfToken).send({});
  // Hanging up an answered call is a finished call; hanging up before it connects is a cancellation.
  // The simulator connects after ~60 ms, so either outcome is valid; the stored record must match.
  expect(hangup.status).toBe(200); expect(['COMPLETED', 'CANCELLED']).toContain(hangup.body.call.status);
  const stored = await prisma.callDirectRecord.findUnique({ where: { id: call.recordId } }); expect(stored.status).toBe(hangup.body.call.status);
  expect(calls.bindDirectAudio(auth, call.id, call.audioToken, socket)).toBeNull();
  const second = await start(); expect(second.status).toBe(202);
  await agent.post(`/api/org/wa-calls/direct/${second.body.call.id}/hangup`).set('X-CSRF-Token', csrfToken).send({});
  const history = await agent.get('/api/org/wa-calls/history'); expect(history.status).toBe(200);
  expect(await prisma.callDirectRecord.count()).toBe(2);
});
