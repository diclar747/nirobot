const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function setupTwoOrgs() {
  const orgA = await createOrganization(prisma, { slug: 'org-a' });
  const orgB = await createOrganization(prisma, { slug: 'org-b' });

  const ownerA = await createUser(prisma, { organizationId: orgA.id, email: 'owner@org-a.test', role: 'OWNER' });
  const adminA = await createUser(prisma, { organizationId: orgA.id, email: 'admin@org-a.test', role: 'ADMIN' });
  const ownerB = await createUser(prisma, { organizationId: orgB.id, email: 'owner@org-b.test', role: 'OWNER' });

  const deptA = await prisma.department.create({ data: { organizationId: orgA.id, name: 'Ventas' } });
  const deptB = await prisma.department.create({ data: { organizationId: orgB.id, name: 'Ventas' } });

  return { orgA, orgB, ownerA, adminA, ownerB, deptA, deptB };
}

beforeEach(async () => {
  await resetDb();
});

describe('Aislamiento multiempresa', () => {
  test('la lista de usuarios de una organización nunca incluye usuarios de otra', async () => {
    const { orgB, adminA } = await setupTwoOrgs();
    const { agent } = await loginAgent(app, adminA.email);

    const res = await agent.get('/api/org/users');
    expect(res.status).toBe(200);
    const emails = res.body.users.map((u) => u.email);
    expect(emails).not.toContain('owner@org-b.test');
    expect(res.body.users.every((u) => u.email.endsWith('org-a.test'))).toBe(true);
    void orgB;
  });

  test('no se puede leer un usuario de otra organización manipulando el id en la URL (404, no 403)', async () => {
    const { adminA, ownerB } = await setupTwoOrgs();
    const { agent, csrfToken } = await loginAgent(app, adminA.email);

    const res = await agent
      .patch(`/api/org/users/${ownerB.id}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Hackeado' });

    expect(res.status).toBe(404);

    const untouched = await prisma.user.findUnique({ where: { id: ownerB.id } });
    expect(untouched.name).toBe(ownerB.name);
  });

  test('no se puede modificar ni borrar un departamento de otra organización manipulando el id', async () => {
    const { adminA, deptB } = await setupTwoOrgs();
    const { agent, csrfToken } = await loginAgent(app, adminA.email);

    const patchRes = await agent
      .patch(`/api/org/departments/${deptB.id}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Robado' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await agent.delete(`/api/org/departments/${deptB.id}`).set('X-CSRF-Token', csrfToken);
    expect(deleteRes.status).toBe(404);

    const stillThere = await prisma.department.findUnique({ where: { id: deptB.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere.name).toBe('Ventas');
  });

  test('no se puede agregar como miembro a un usuario de otra organización', async () => {
    const { adminA, deptA, ownerB } = await setupTwoOrgs();
    const { agent, csrfToken } = await loginAgent(app, adminA.email);

    const res = await agent
      .post(`/api/org/departments/${deptA.id}/members`)
      .set('X-CSRF-Token', csrfToken)
      .send({ userId: ownerB.id });

    expect(res.status).toBe(404);
    const membership = await prisma.departmentMember.findFirst({ where: { departmentId: deptA.id, userId: ownerB.id } });
    expect(membership).toBeNull();
  });

  test('un organizationId inyectado en el body es ignorado: el usuario creado queda en la organización del token', async () => {
    const { orgA, orgB, adminA } = await setupTwoOrgs();
    const { agent, csrfToken } = await loginAgent(app, adminA.email);

    const res = await agent
      .post('/api/org/users')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Nuevo Agente', email: 'nuevo@org-a.test', role: 'AGENT', organizationId: orgB.id });

    expect(res.status).toBe(201);
    const created = await prisma.user.findUnique({ where: { email: 'nuevo@org-a.test' } });
    expect(created.organizationId).toBe(orgA.id);
    expect(created.organizationId).not.toBe(orgB.id);
  });

  test('el perfil y los ajustes de una organización solo devuelven los datos propios', async () => {
    const { ownerA, ownerB } = await setupTwoOrgs();
    const { agent } = await loginAgent(app, ownerA.email);

    const res = await agent.get('/api/org');
    expect(res.status).toBe(200);
    expect(res.body.organization.slug).toBe('org-a');
    void ownerB;
  });
});
