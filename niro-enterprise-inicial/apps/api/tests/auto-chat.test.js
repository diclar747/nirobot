const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const chatAccess = require('../src/lib/chatAccess');

beforeEach(async () => { await resetDb(); chatAccess.invalidateAgentCache(); });
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

const send = (s, method, path, body) => s.agent[method](path).set('X-CSRF-Token', s.csrfToken).send(body);

async function setup() {
  const org = await createOrganization(prisma, { slug: `ac-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@ac.test`, role: 'OWNER' });
  const auto = await createUser(prisma, { organizationId: org.id, email: `auto${Date.now()}@ac.test`, role: 'AGENT', autoChat: true });
  const manual = await createUser(prisma, { organizationId: org.id, email: `man${Date.now()}@ac.test`, role: 'AGENT', autoChat: false });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000001' } });
  const conversation = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp' } });
  // Las sesiones se inician solo cuando el test las usa (el login tiene límite de intentos).
  const login = (user) => loginAgent(app, user.email);
  return { org, owner, auto, manual, contact, conversation, login };
}

const listIds = async (s) => (await s.agent.get('/api/org/conversations')).body.conversations.map((c) => c.id);

describe('Auto chat: los chats nuevos le llegan solos al agente que lo tiene activado', () => {
  test('un chat nuevo sin asignar lo ven los agentes con auto chat, no los demás', async () => {
    const { auto, manual, owner, conversation, login } = await setup();
    const [autoS, manualS, admin] = [await login(auto), await login(manual), await login(owner)];
    expect(await listIds(autoS)).toContain(conversation.id);
    expect(await listIds(manualS)).not.toContain(conversation.id);
    expect(await listIds(admin)).toContain(conversation.id);
    expect((await autoS.agent.get(`/api/org/conversations/${conversation.id}`)).status).toBe(200);
    expect((await manualS.agent.get(`/api/org/conversations/${conversation.id}`)).status).toBe(404);
  });

  test('el agente con auto chat puede responder el chat; el otro no puede ni escribirle', async () => {
    const { auto, manual, conversation, login } = await setup();
    const [autoS, manualS] = [await login(auto), await login(manual)];
    const denied = await send(manualS, 'post', `/api/org/conversations/${conversation.id}/messages`, { content: 'hola' });
    expect(denied.status).toBe(404);
    const ok = await send(autoS, 'post', `/api/org/conversations/${conversation.id}/messages`, { content: 'hola', internal: true });
    expect(ok.status).not.toBe(404);
  });

  test('sin auto chat, el chat le llega cuando el administrador se lo transfiere, y deja de verlo el otro agente', async () => {
    const { owner, auto, manual, conversation, login } = await setup();
    const [admin, autoS, manualS] = [await login(owner), await login(auto), await login(manual)];
    const transfer = await send(admin, 'post', `/api/org/conversations/${conversation.id}/transfer`, { targetUserId: manual.id });
    expect(transfer.status).toBe(200);
    expect(await listIds(manualS)).toContain(conversation.id);
    expect(await listIds(autoS)).not.toContain(conversation.id); // ya está asignado a otro agente
  });

  test('un chat enviado a un área solo lo ven los miembros de esa área', async () => {
    const { org, auto, manual, conversation, login } = await setup();
    const [autoS, manualS] = [await login(auto), await login(manual)];
    const dept = await prisma.department.create({ data: { organizationId: org.id, name: 'Caja' } });
    await prisma.departmentMember.create({ data: { departmentId: dept.id, userId: manual.id } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { departmentId: dept.id } });
    chatAccess.invalidateAgentCache();
    expect(await listIds(manualS)).toContain(conversation.id); // es de Caja, aunque no tenga auto chat
    expect(await listIds(autoS)).not.toContain(conversation.id); // auto chat solo cubre chats sin área
  });

  test('tomar un chat: solo puede quien lo ve; el segundo recibe 409', async () => {
    const { auto, manual, conversation, login } = await setup();
    const [autoS, manualS] = [await login(auto), await login(manual)];
    expect((await send(manualS, 'post', `/api/org/conversations/${conversation.id}/claim`, {})).status).toBe(409);
    expect((await send(autoS, 'post', `/api/org/conversations/${conversation.id}/claim`, {})).status).toBe(200);
    expect((await prisma.conversation.findUnique({ where: { id: conversation.id } })).assignedToId).toBe(auto.id);
  });

  test('los no leídos solo cuentan lo que el agente puede ver', async () => {
    const { auto, manual, conversation, login } = await setup();
    const [autoS, manualS] = [await login(auto), await login(manual)];
    await prisma.message.create({ data: { conversationId: conversation.id, direction: 'INBOUND', content: 'Hola' } });
    expect((await autoS.agent.get('/api/org/conversations/unread-summary')).body.conversations).toBe(1);
    expect((await manualS.agent.get('/api/org/conversations/unread-summary')).body.conversations).toBe(0);
  });

  test('canAgentSee y agentAudience aplican la misma regla', async () => {
    const { org, auto, manual, conversation } = await setup();
    const audience = await chatAccess.agentAudience(org.id, { assignedToId: null, departmentId: null });
    expect(audience.seeing).toEqual([auto.id]);
    expect(audience.hidden).toEqual([manual.id]);
    expect(chatAccess.canAgentSee({ userId: 'a', deptIds: [], autoChat: false }, { assignedToId: 'a', departmentId: null })).toBe(true);
    expect(chatAccess.canAgentSee({ userId: 'a', deptIds: [], autoChat: true }, { assignedToId: 'b', departmentId: null })).toBe(false);
    expect(conversation.id).toBeTruthy();
  });

  test('al crear un agente se elige el auto chat; se puede cambiar después y solo aplica a agentes', async () => {
    const { owner, login } = await setup();
    const admin = await login(owner);
    const withAuto = await send(admin, 'post', '/api/org/users', { name: 'Ana Auto', email: 'ana@ac.test', role: 'AGENT', autoChat: true });
    expect(withAuto.status).toBe(201);
    expect(withAuto.body.user.autoChat).toBe(true);
    const without = await send(admin, 'post', '/api/org/users', { name: 'Beto Manual', email: 'beto@ac.test', role: 'AGENT' });
    expect(without.body.user.autoChat).toBe(false);
    const sup = await send(admin, 'post', '/api/org/users', { name: 'Sara Sup', email: 'sara@ac.test', role: 'SUPERVISOR', autoChat: true });
    expect(sup.body.user.autoChat).toBe(false);
    const toggled = await send(admin, 'patch', `/api/org/users/${without.body.user.id}`, { autoChat: true });
    expect(toggled.status).toBe(200);
    expect(toggled.body.user.autoChat).toBe(true);
    const list = await admin.agent.get('/api/org/users');
    expect(list.body.users.find((u) => u.email === 'beto@ac.test').autoChat).toBe(true);
  });
});
