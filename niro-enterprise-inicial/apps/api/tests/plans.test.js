const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const billing = require('../src/lib/billing');

const PLAN_IDS = ['plan-basico', 'plan-estandar', 'plan-manager', 'plan-ejecutivo', 'plan-corporativo'];

async function cleanup() {
  await prisma.platformNoticeRead.deleteMany();
  await prisma.platformNotice.deleteMany();
  await prisma.billingPayment.deleteMany();
  await resetDb();
  await prisma.plan.deleteMany({ where: { id: { notIn: PLAN_IDS } } });
}
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });
beforeEach(async () => { await cleanup(); billing.clearBlockedCache(); });

async function orgWithPlan(planId, extra = {}) {
  const org = await createOrganization(prisma, { slug: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  await prisma.organization.update({ where: { id: org.id }, data: { planId, paidUntil: new Date(Date.now() + 86400000), trialEndsAt: new Date(Date.now() - 1000), ...extra } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}${Math.random().toString(36).slice(2, 5)}@pl.test`, role: 'OWNER' });
  return { org, ...(await loginAgent(app, owner.email)) };
}

describe('Planes iniciales', () => {
  test('existen los 5 planes con precio y agentes pedidos', async () => {
    const plans = await prisma.plan.findMany({ where: { id: { in: PLAN_IDS } }, orderBy: { sortOrder: 'asc' } });
    expect(plans.map((p) => [p.name, p.priceGs, p.maxAgents])).toEqual([
      ['Básico', 49000, 1], ['Estándar', 80000, 2], ['Manager', 160000, 5], ['Ejecutivo', 320000, 10], ['Corporativo', 640000, 20]
    ]);
  });
});

describe('Límite de agentes por plan', () => {
  test('Básico permite propietario + 1 agente y bloquea al segundo', async () => {
    const { agent, csrfToken } = await orgWithPlan('plan-basico');
    const first = await agent.post('/api/org/users').set('X-CSRF-Token', csrfToken).send({ name: 'Agente Uno', email: 'a1@pl.test', role: 'AGENT' });
    expect(first.status).toBe(201);
    const second = await agent.post('/api/org/users').set('X-CSRF-Token', csrfToken).send({ name: 'Agente Dos', email: 'a2@pl.test', role: 'AGENT' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/Básico/);
    expect(second.body.error).toMatch(/1 agente/);
  });

  test('Estándar permite 2 agentes y el tercero no (y no se esquiva creando otro propietario)', async () => {
    const { agent, csrfToken } = await orgWithPlan('plan-estandar');
    for (const n of [1, 2]) {
      expect((await agent.post('/api/org/users').set('X-CSRF-Token', csrfToken).send({ name: `Agente ${n}`, email: `e${n}@pl.test`, role: 'AGENT' })).status).toBe(201);
    }
    expect((await agent.post('/api/org/users').set('X-CSRF-Token', csrfToken).send({ name: 'Otro', email: 'e3@pl.test', role: 'OWNER' })).status).toBe(409);
  });

  test('reactivar un usuario desactivado también respeta el cupo', async () => {
    const { org, agent, csrfToken } = await orgWithPlan('plan-basico');
    const a = await agent.post('/api/org/users').set('X-CSRF-Token', csrfToken).send({ name: 'Agente Uno', email: 'r1@pl.test', role: 'AGENT' });
    await agent.patch(`/api/org/users/${a.body.user.id}`).set('X-CSRF-Token', csrfToken).send({ active: false });
    expect((await agent.post('/api/org/users').set('X-CSRF-Token', csrfToken).send({ name: 'Agente Dos', email: 'r2@pl.test', role: 'AGENT' })).status).toBe(201);
    const back = await agent.patch(`/api/org/users/${a.body.user.id}`).set('X-CSRF-Token', csrfToken).send({ active: true });
    expect(back.status).toBe(409);
    expect(org.id).toBeTruthy();
  });

  test('en la prueba gratuita se permiten 2 agentes y el estado muestra el uso', async () => {
    const org = await createOrganization(prisma, { slug: `trial-${Date.now()}` });
    await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000) } });
    const owner = await createUser(prisma, { organizationId: org.id, email: `t${Date.now()}@pl.test`, role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);
    for (const n of [1, 2]) expect((await agent.post('/api/org/users').set('X-CSRF-Token', csrfToken).send({ name: `T ${n}`, email: `t${n}${Date.now()}@pl.test`, role: 'AGENT' })).status).toBe(201);
    const third = await agent.post('/api/org/users').set('X-CSRF-Token', csrfToken).send({ name: 'T 3', email: `t3${Date.now()}@pl.test`, role: 'AGENT' });
    expect(third.status).toBe(409);
    const status = await agent.get('/api/org/billing/status');
    expect(status.body.seats).toMatchObject({ maxAgents: 2, agentsUsed: 2, full: true, planName: 'Prueba gratuita' });
  });
});

describe('Cobro por plan', () => {
  test('lista solo planes activos y activar el pago asigna el plan pagado', async () => {
    const { org, agent } = await orgWithPlan(null, { paidUntil: null });
    await prisma.plan.update({ where: { id: 'plan-corporativo' }, data: { active: false } });
    const list = await agent.get('/api/org/billing/plans');
    expect(list.body.plans.map((p) => p.name)).toEqual(['Básico', 'Estándar', 'Manager', 'Ejecutivo']);
    await prisma.plan.update({ where: { id: 'plan-corporativo' }, data: { active: true } });

    const payment = await prisma.billingPayment.create({ data: { organizationId: org.id, amount: 160000, planId: 'plan-manager', planName: 'Manager' } });
    await billing.activatePayment(payment);
    const updated = await prisma.organization.findUnique({ where: { id: org.id } });
    expect(updated.planId).toBe('plan-manager');
    const seats = await billing.seatInfo(org.id);
    expect(seats).toMatchObject({ planName: 'Manager', maxAgents: 5, state: 'active' });
  });

  test('el checkout exige un plan disponible', async () => {
    const { agent, csrfToken } = await orgWithPlan(null, { paidUntil: null, trialEndsAt: new Date(Date.now() + 3600000) });
    const res = await agent.post('/api/org/billing/checkout').set('X-CSRF-Token', csrfToken).send({ planId: 'no-existe' });
    expect(res.status).toBe(400);
  });
});

describe('Superadmin: editar, crear y eliminar planes', () => {
  async function superadmin() {
    const sa = await createUser(prisma, { organizationId: null, email: `sa${Date.now()}@pl.test`, role: 'SUPERADMIN' });
    return loginAgent(app, sa.email);
  }

  test('crea, edita (cambia el cupo al instante), oculta y elimina un plan', async () => {
    const { agent, csrfToken } = await superadmin();
    const created = await agent.post('/api/superadmin/plans').set('X-CSRF-Token', csrfToken).send({ name: 'Gigante', priceGs: 1280000, maxAgents: 40, features: ['A', 'B'] });
    expect(created.status).toBe(201);
    const id = created.body.plan.id;

    const org = await createOrganization(prisma, { slug: `sa-${Date.now()}` });
    await prisma.organization.update({ where: { id: org.id }, data: { planId: 'plan-basico', paidUntil: new Date(Date.now() + 86400000), trialEndsAt: new Date(Date.now() - 1000) } });
    await createUser(prisma, { organizationId: org.id, email: `own${Date.now()}@pl.test`, role: 'OWNER' });
    expect((await billing.seatInfo(org.id)).maxAgents).toBe(1);
    expect((await agent.patch('/api/superadmin/plans/plan-basico').set('X-CSRF-Token', csrfToken).send({ maxAgents: 3 })).status).toBe(200);
    expect((await billing.seatInfo(org.id)).maxAgents).toBe(3);
    await agent.patch('/api/superadmin/plans/plan-basico').set('X-CSRF-Token', csrfToken).send({ maxAgents: 1 });

    expect((await agent.delete('/api/superadmin/plans/plan-basico').set('X-CSRF-Token', csrfToken)).status).toBe(409); // en uso
    expect((await agent.delete(`/api/superadmin/plans/${id}`).set('X-CSRF-Token', csrfToken)).status).toBe(200);
    const all = await agent.get('/api/superadmin/plans');
    expect(all.body.plans.find((p) => p.id === id)).toBeUndefined();
    expect(all.body.plans.find((p) => p.id === 'plan-basico').organizations).toBe(1);
  });

  test('valida datos y un cliente común no puede tocar planes', async () => {
    const { agent, csrfToken } = await superadmin();
    expect((await agent.post('/api/superadmin/plans').set('X-CSRF-Token', csrfToken).send({ name: 'X', priceGs: 5, maxAgents: 1 })).status).toBe(400);
    expect((await agent.post('/api/superadmin/plans').set('X-CSRF-Token', csrfToken).send({ name: 'Ok', priceGs: 50000, maxAgents: -1 })).status).toBe(400);
    const { agent: client, csrfToken: ct } = await orgWithPlan('plan-basico');
    expect((await client.post('/api/superadmin/plans').set('X-CSRF-Token', ct).send({ name: 'Hack', priceGs: 1000, maxAgents: 1 })).status).toBe(403);
  });
});
