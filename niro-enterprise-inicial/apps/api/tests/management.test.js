const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const chatAccess = require('../src/lib/chatAccess');

let org, owner, ana, beto, admin, anaS, betoS;
const send = (s, method, path, body) => s.agent[method](path).set('X-CSRF-Token', s.csrfToken).send(body);
const get = (s, path) => s.agent.get(path);

beforeAll(async () => {
  await resetDb();
  org = await createOrganization(prisma, { slug: `mg-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@mg.test`, role: 'OWNER' });
  ana = await createUser(prisma, { organizationId: org.id, email: `ana${Date.now()}@mg.test`, role: 'AGENT', autoChat: true });
  beto = await createUser(prisma, { organizationId: org.id, email: `beto${Date.now()}@mg.test`, role: 'AGENT', autoChat: true });
  await prisma.user.updateMany({ where: { id: ana.id }, data: { name: 'Ana Gómez' } });
  await prisma.user.updateMany({ where: { id: beto.id }, data: { name: 'Beto Ruiz' } });
  [admin, anaS, betoS] = [await loginAgent(app, owner.email), await loginAgent(app, ana.email), await loginAgent(app, beto.email)];
});
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.conversationOutcome.deleteMany({});
  await prisma.conversation.deleteMany({});
  chatAccess.invalidateAgentCache();
});

async function conversation(assignedToId = null) {
  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: `Cliente ${Math.random().toString(36).slice(2, 6)}`, phone: `5959${Math.floor(Math.random() * 1e8)}` } });
  return prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', assignedToId } });
}
const categories = async () => Object.fromEntries((await get(admin, '/api/org/management/categories?all=1')).body.categories.map((c) => [c.name, c]));

describe('Categorías de gestión', () => {
  test('cada empresa parte con cuatro categorías y el administrador puede crear otras', async () => {
    const list = await categories();
    expect(Object.keys(list)).toEqual(expect.arrayContaining(['Venta cerrada', 'Venta perdida', 'Cotización enviada', 'Cotización entregada']));
    expect(list['Venta cerrada']).toMatchObject({ kind: 'WON', requiresAmount: true });
    const created = await send(admin, 'post', '/api/org/management/categories', { name: 'Seguimiento', kind: 'OTHER', color: '#f59e0b' });
    expect(created.status).toBe(201);
    expect((await send(admin, 'post', '/api/org/management/categories', { name: 'Seguimiento' })).status).toBe(409);
    const renamed = await send(admin, 'patch', `/api/org/management/categories/${created.body.category.id}`, { name: 'Seguimiento posventa' });
    expect(renamed.body.category.name).toBe('Seguimiento posventa');
    expect((await send(admin, 'delete', `/api/org/management/categories/${created.body.category.id}`, {})).body).toMatchObject({ ok: true, deactivated: false });
  });

  test('un agente ve las categorías activas pero no puede crearlas ni borrarlas', async () => {
    const list = await get(anaS, '/api/org/management/categories');
    expect(list.status).toBe(200);
    expect(list.body.categories.length).toBeGreaterThanOrEqual(4);
    const cat = (await categories())['Venta perdida'];
    expect((await send(anaS, 'post', '/api/org/management/categories', { name: 'Otra' })).status).toBe(403);
    expect((await send(anaS, 'delete', `/api/org/management/categories/${cat.id}`, {})).status).toBe(403);
  });
});

describe('Cerrar una conversación con su resultado', () => {
  test('sin indicar cómo terminó no se puede cerrar ni resolver', async () => {
    const conv = await conversation(ana.id);
    const res = await send(anaS, 'patch', `/api/org/conversations/${conv.id}`, { status: 'CLOSED' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OUTCOME_REQUIRED');
    expect((await prisma.conversation.findUnique({ where: { id: conv.id } })).status).toBe('OPEN');
    expect((await send(anaS, 'patch', `/api/org/conversations/${conv.id}`, { status: 'RESOLVED' })).status).toBe(400);
    expect((await send(anaS, 'patch', `/api/org/conversations/${conv.id}`, { priority: 'HIGH' })).status).toBe(200); // otros cambios siguen libres
  });

  test('venta cerrada exige el monto; con monto queda registrada a nombre del agente y cierra el chat', async () => {
    const conv = await conversation(ana.id);
    const cat = (await categories())['Venta cerrada'];
    const noAmount = await send(anaS, 'patch', `/api/org/conversations/${conv.id}`, { status: 'CLOSED', outcome: { categoryId: cat.id } });
    expect(noAmount.status).toBe(400);
    expect(noAmount.body.error).toMatch(/monto/i);
    expect((await prisma.conversation.findUnique({ where: { id: conv.id } })).status).toBe('OPEN');

    const ok = await send(anaS, 'patch', `/api/org/conversations/${conv.id}`, { status: 'CLOSED', outcome: { categoryId: cat.id, amount: 1500000, note: 'Pagó al contado' } });
    expect(ok.status).toBe(200);
    expect(ok.body.conversation.status).toBe('CLOSED');
    expect(ok.body.conversation.tags).toContain('Cerradas');
    const row = await prisma.conversationOutcome.findFirst({ where: { conversationId: conv.id } });
    expect(row).toMatchObject({ agentId: ana.id, agentName: 'Ana Gómez', categoryName: 'Venta cerrada', kind: 'WON', closedConversation: true, note: 'Pagó al contado' });
    expect(Number(row.amount)).toBe(1500000);
  });

  test('venta perdida y "Marcar como resuelto" también registran su resultado', async () => {
    const conv = await conversation(ana.id);
    const lost = (await categories())['Venta perdida'];
    const res = await send(anaS, 'patch', `/api/org/conversations/${conv.id}`, { status: 'RESOLVED', outcome: { categoryId: lost.id, note: 'Eligió otra marca' } });
    expect(res.status).toBe(200);
    expect(res.body.conversation.status).toBe('RESOLVED');
    expect((await prisma.conversationOutcome.findFirst({ where: { conversationId: conv.id } })).kind).toBe('LOST');
  });

  test('una cotización se registra sin cerrar el chat; el monto es opcional', async () => {
    const conv = await conversation(ana.id);
    const quote = (await categories())['Cotización enviada'];
    const res = await send(anaS, 'post', `/api/org/conversations/${conv.id}/outcome`, { categoryId: quote.id, amount: '2.500.000', note: 'Presupuesto 1' });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toMatchObject({ kind: 'QUOTE', amount: 2500000, agentName: 'Ana Gómez', closedConversation: false });
    expect((await prisma.conversation.findUnique({ where: { id: conv.id } })).status).toBe('OPEN');
    expect((await send(anaS, 'post', `/api/org/conversations/${conv.id}/outcome`, { categoryId: quote.id })).status).toBe(201);
    // Queda escrita en el chat como nota interna, con el monto y quién la registró.
    const notes = await prisma.message.findMany({ where: { conversationId: conv.id, direction: 'NOTE' }, orderBy: { createdAt: 'asc' } });
    expect(notes).toHaveLength(2);
    expect(notes[0].content).toContain('[GESTIÓN]');
    expect(notes[0].content).toContain('Ana Gómez');
    expect(notes[0].content).toContain('Cotización enviada');
    expect(notes[0].content).toContain('2.500.000');
  });

  test('un agente no puede registrar gestión de un chat que no ve, ni usar categorías ajenas o desactivadas', async () => {
    const mine = await conversation(ana.id);
    const cat = (await categories())['Venta perdida'];
    expect((await send(betoS, 'post', `/api/org/conversations/${mine.id}/outcome`, { categoryId: cat.id })).status).toBe(404);
    const other = await createOrganization(prisma, { slug: `mg2-${Date.now()}` });
    const foreign = await prisma.outcomeCategory.create({ data: { organizationId: other.id, name: 'Ajena', kind: 'LOST' } });
    expect((await send(anaS, 'post', `/api/org/conversations/${mine.id}/outcome`, { categoryId: foreign.id })).status).toBe(400);
    await prisma.outcomeCategory.update({ where: { id: cat.id }, data: { active: false } });
    expect((await send(anaS, 'post', `/api/org/conversations/${mine.id}/outcome`, { categoryId: cat.id })).status).toBe(400);
    await prisma.outcomeCategory.update({ where: { id: cat.id }, data: { active: true } });
  });

  test('renombrar o borrar una categoría con historial no cambia lo ya registrado', async () => {
    const conv = await conversation(ana.id);
    const cat = (await categories())['Cotización entregada'];
    await send(anaS, 'post', `/api/org/conversations/${conv.id}/outcome`, { categoryId: cat.id });
    await send(admin, 'patch', `/api/org/management/categories/${cat.id}`, { name: 'Entrega de cotización' });
    expect((await prisma.conversationOutcome.findFirst({ where: { conversationId: conv.id } })).categoryName).toBe('Cotización entregada');
    const del = await send(admin, 'delete', `/api/org/management/categories/${cat.id}`, {});
    expect(del.body.deactivated).toBe(true);
    expect((await get(anaS, '/api/org/management/categories')).body.categories.map((c) => c.id)).not.toContain(cat.id);
    await send(admin, 'patch', `/api/org/management/categories/${cat.id}`, { name: 'Cotización entregada', active: true });
  });
});

describe('Análisis de gestión por agente', () => {
  async function seed() {
    const cats = await categories();
    const rec = async (agent, session, name, amount) => {
      const conv = await conversation(agent.id);
      const res = await send(session, 'post', `/api/org/conversations/${conv.id}/outcome`, { categoryId: cats[name].id, amount, close: true });
      expect(res.status).toBe(201);
    };
    await rec(ana, anaS, 'Venta cerrada', 1000000);
    await rec(ana, anaS, 'Venta cerrada', 3000000);
    await rec(ana, anaS, 'Venta perdida');
    await rec(ana, anaS, 'Cotización enviada', 500000);
    await rec(beto, betoS, 'Venta cerrada', 2000000);
    await rec(beto, betoS, 'Venta perdida');
    await rec(beto, betoS, 'Venta perdida');
    return cats;
  }

  test('el administrador ve totales, ventas, monto, ticket promedio y tasa de cierre por agente', async () => {
    await seed();
    const res = await get(admin, '/api/org/management/summary');
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ outcomes: 7, won: 3, lost: 3, quotes: 1, revenue: 6000000, avgTicket: 2000000, winRate: 50, closed: 7 });
    const byAgent = Object.fromEntries(res.body.byAgent.map((a) => [a.name, a]));
    expect(byAgent['Ana Gómez']).toMatchObject({ outcomes: 4, won: 2, lost: 1, quotes: 1, revenue: 4000000, avgTicket: 2000000 });
    expect(byAgent['Ana Gómez'].winRate).toBeCloseTo(66.7, 1);
    expect(byAgent['Beto Ruiz']).toMatchObject({ won: 1, lost: 2, revenue: 2000000 });
    expect(res.body.byAgent[0].name).toBe('Ana Gómez'); // ordenado por lo vendido
    expect(res.body.byCategory.find((c) => c.name === 'Venta cerrada')).toMatchObject({ count: 3, amount: 6000000 });
    expect(res.body.daily).toHaveLength(1);
    expect(res.body.daily[0]).toMatchObject({ outcomes: 7, won: 3, revenue: 6000000 });
  });

  test('filtros por agente, categoría, tipo y fecha', async () => {
    const cats = await seed();
    const byBeto = await get(admin, `/api/org/management/summary?agentId=${beto.id}`);
    expect(byBeto.body.totals).toMatchObject({ outcomes: 3, revenue: 2000000 });
    expect(byBeto.body.byAgent.map((a) => a.name)).toEqual(['Beto Ruiz']);
    expect((await get(admin, `/api/org/management/summary?categoryId=${cats['Venta perdida'].id}`)).body.totals).toMatchObject({ outcomes: 3, lost: 3, revenue: 0 });
    expect((await get(admin, '/api/org/management/summary?kind=QUOTE')).body.totals.outcomes).toBe(1);
    const future = new Date(Date.now() + 86400000).toISOString();
    expect((await get(admin, `/api/org/management/summary?from=${encodeURIComponent(future)}&to=${encodeURIComponent(new Date(Date.now() + 2 * 86400000).toISOString())}`)).body.totals.outcomes).toBe(0);
    const list = await get(admin, `/api/org/management/outcomes?agentId=${ana.id}&kind=WON`);
    expect(list.body.total).toBe(2);
    expect(list.body.outcomes.map((o) => o.amount).sort()).toEqual([1000000, 3000000]);
    expect(list.body.outcomes[0]).toMatchObject({ agentName: 'Ana Gómez', categoryName: 'Venta cerrada' });
    expect((await get(admin, '/api/org/management/outcomes?q=beto')).body.total).toBe(3);
  });

  test('un agente solo ve su propia gestión aunque pida la de otro', async () => {
    await seed();
    const own = await get(anaS, `/api/org/management/summary?agentId=${beto.id}`);
    expect(own.body.totals.outcomes).toBe(4);
    expect(own.body.byAgent.map((a) => a.name)).toEqual(['Ana Gómez']);
    const list = await get(anaS, `/api/org/management/outcomes?agentId=${beto.id}`);
    expect(list.body.outcomes.every((o) => o.agentId === ana.id)).toBe(true);
  });

  test('incluye la actividad de chat de cada agente y exporta a CSV', async () => {
    await seed();
    const conv = await conversation(ana.id);
    await prisma.message.createMany({ data: [
      { conversationId: conv.id, direction: 'OUTBOUND', content: 'Hola', senderUserId: ana.id },
      { conversationId: conv.id, direction: 'OUTBOUND', content: 'Te paso el precio', senderUserId: ana.id }
    ] });
    const res = await get(admin, '/api/org/management/summary');
    expect(res.body.byAgent.find((a) => a.name === 'Ana Gómez')).toMatchObject({ messages: 2, chats: 1 });
    const csv = await get(admin, '/api/org/management/outcomes?format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Ana Gómez');
    expect(csv.text.split('\n')).toHaveLength(8); // encabezado + 7
  });

  test('si el administrador apaga el permiso, el agente no accede a la gestión', async () => {
    await prisma.user.update({ where: { id: beto.id }, data: { permissions: { management: false } } });
    const s = await loginAgent(app, beto.email);
    expect((await get(s, '/api/org/management/summary')).status).toBe(403);
    await prisma.user.update({ where: { id: beto.id }, data: { permissions: {} } });
  });
});
