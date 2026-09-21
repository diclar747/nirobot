const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function team() {
  const org = await createOrganization(prisma, { slug: `qr-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@qr.test`, role: 'OWNER' });
  const agentUser = await createUser(prisma, { organizationId: org.id, email: `a${Date.now()}@qr.test`, role: 'AGENT' });
  return { org, agentUser, admin: await loginAgent(app, owner.email), agent: await loginAgent(app, agentUser.email) };
}
const create = (s, body) => s.agent.post('/api/org/quick-replies').set('X-CSRF-Token', s.csrfToken).send(body);

describe('Respuestas rápidas', () => {
  test('crea con atajo normalizado, lista, busca por texto y ordena por uso', async () => {
    const { admin, agent } = await team();
    const a = await create(admin, { shortcut: '/Cuenta Bancaria', title: 'Datos de cuenta', content: 'Banco Itaú\nCuenta 123\nTitular {{agente}}' });
    expect(a.status).toBe(201);
    expect(a.body.quickReply.shortcut).toBe('cuenta-bancaria');
    expect(a.body.quickReply.content).toContain('\n'); // conserva saltos de línea
    await create(admin, { shortcut: 'horario', title: 'Horario de atención', content: 'Lunes a viernes de 8 a 18' });

    const list = await agent.agent.get('/api/org/quick-replies'); // un agente ve las compartidas
    expect(list.body.quickReplies).toHaveLength(2);
    expect((await agent.agent.get('/api/org/quick-replies?q=/cuen')).body.quickReplies.map((r) => r.shortcut)).toEqual(['cuenta-bancaria']);
    expect((await agent.agent.get('/api/org/quick-replies?q=viernes')).body.quickReplies).toHaveLength(1);

    const horario = list.body.quickReplies.find((r) => r.shortcut === 'horario');
    await agent.agent.post(`/api/org/quick-replies/${horario.id}/use`).set('X-CSRF-Token', agent.csrfToken);
    await agent.agent.post(`/api/org/quick-replies/${horario.id}/use`).set('X-CSRF-Token', agent.csrfToken);
    expect((await agent.agent.get('/api/org/quick-replies')).body.quickReplies[0].shortcut).toBe('horario');
  });

  test('atajo repetido → 409; datos inválidos → 400', async () => {
    const { admin } = await team();
    expect((await create(admin, { shortcut: 'hola', title: 'Saludo', content: 'Hola!' })).status).toBe(201);
    const dup = await create(admin, { shortcut: '/HOLA', title: 'Otro', content: 'x' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/\/hola/);
    expect((await create(admin, { shortcut: 'con espacios raros!!', title: 'x', content: 'y' })).status).toBe(400);
    expect((await create(admin, { shortcut: 'ok', title: '', content: 'y' })).status).toBe(400);
    expect((await create(admin, { shortcut: 'ok', title: 'x', content: '' })).status).toBe(400);
  });

  test('las personales solo las ve su dueño; editar/borrar: dueño o admin', async () => {
    const { admin, agent } = await team();
    const mine = await create(agent, { shortcut: 'privada', title: 'Mía', content: 'solo yo', shared: false });
    expect(mine.status).toBe(201);
    expect((await admin.agent.get('/api/org/quick-replies')).body.quickReplies.map((r) => r.shortcut)).not.toContain('privada');
    expect((await agent.agent.get('/api/org/quick-replies')).body.quickReplies.map((r) => r.shortcut)).toContain('privada');

    const shared = await create(admin, { shortcut: 'equipo', title: 'Equipo', content: 'para todos' });
    // un agente no puede tocar la del admin
    expect((await agent.agent.patch(`/api/org/quick-replies/${shared.body.quickReply.id}`).set('X-CSRF-Token', agent.csrfToken).send({ content: 'hack' })).status).toBe(403);
    expect((await agent.agent.delete(`/api/org/quick-replies/${shared.body.quickReply.id}`).set('X-CSRF-Token', agent.csrfToken)).status).toBe(403);
    // el admin sí puede editar la del agente
    const edit = await admin.agent.patch(`/api/org/quick-replies/${mine.body.quickReply.id}`).set('X-CSRF-Token', admin.csrfToken).send({ content: 'editada' });
    expect(edit.status).toBe(200);
    expect((await admin.agent.delete(`/api/org/quick-replies/${mine.body.quickReply.id}`).set('X-CSRF-Token', admin.csrfToken)).status).toBe(200);
  });

  test('el admin puede quitar a un agente la creación, pero seguir usándolas', async () => {
    const { agentUser, admin, agent } = await team();
    await create(admin, { shortcut: 'gracias', title: 'Gracias', content: 'Gracias por escribirnos' });
    await admin.agent.patch(`/api/org/users/${agentUser.id}`).set('X-CSRF-Token', admin.csrfToken).send({ permissions: { quickReplies: false } });
    expect((await create(agent, { shortcut: 'nueva', title: 'x', content: 'y' })).status).toBe(403);
    expect((await agent.agent.get('/api/org/quick-replies')).body.quickReplies).toHaveLength(1);
  });

  test('aislamiento entre organizaciones', async () => {
    const { admin } = await team();
    await create(admin, { shortcut: 'secreto', title: 'S', content: 'x' });
    const other = await createOrganization(prisma, { slug: `other-${Date.now()}` });
    await prisma.organization.update({ where: { id: other.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
    const u = await createUser(prisma, { organizationId: other.id, email: `x${Date.now()}@other.test`, role: 'OWNER' });
    const s = await loginAgent(app, u.email);
    expect((await s.agent.get('/api/org/quick-replies')).body.quickReplies).toHaveLength(0);
  });
});
