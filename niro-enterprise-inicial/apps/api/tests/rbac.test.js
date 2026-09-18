const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

describe('Permisos por rol dentro de una organización', () => {
  test('un AGENT no puede listar usuarios ni crear departamentos', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const agentUser = await createUser(prisma, { organizationId: org.id, email: 'agent@acme.test', role: 'AGENT' });
    const { agent, csrfToken } = await loginAgent(app, agentUser.email);

    const usersRes = await agent.get('/api/org/users');
    expect(usersRes.status).toBe(403);

    const deptRes = await agent.post('/api/org/departments').set('X-CSRF-Token', csrfToken).send({ name: 'Soporte' });
    expect(deptRes.status).toBe(403);
  });

  test('un ADMIN no puede editar el perfil de la organización (solo OWNER)', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const adminUser = await createUser(prisma, { organizationId: org.id, email: 'admin@acme.test', role: 'ADMIN' });
    const { agent, csrfToken } = await loginAgent(app, adminUser.email);

    const res = await agent.patch('/api/org').set('X-CSRF-Token', csrfToken).send({ name: 'Otro nombre' });
    expect(res.status).toBe(403);
  });

  test('un ADMIN no puede crear ni modificar propietarios', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const adminUser = await createUser(prisma, { organizationId: org.id, email: 'admin@acme.test', role: 'ADMIN' });
    const { agent, csrfToken } = await loginAgent(app, adminUser.email);

    const createRes = await agent
      .post('/api/org/users')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Otro Owner', email: 'owner2@acme.test', role: 'OWNER' });
    expect(createRes.status).toBe(403);

    const patchRes = await agent.patch(`/api/org/users/${owner.id}`).set('X-CSRF-Token', csrfToken).send({ active: false });
    expect(patchRes.status).toBe(403);
  });

  test('no se puede desactivar al último propietario activo ni a uno mismo', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const selfRes = await agent.patch(`/api/org/users/${owner.id}`).set('X-CSRF-Token', csrfToken).send({ active: false });
    expect(selfRes.status).toBe(400);
  });

  test('respeta el límite de usuarios del plan (maxUsers)', async () => {
    const org = await createOrganization(prisma, { slug: 'acme', maxUsers: 1 });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);

    const res = await agent
      .post('/api/org/users')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Nuevo', email: 'nuevo@acme.test', role: 'AGENT' });
    expect(res.status).toBe(409);
    void owner;
  });

  test('las mutaciones sin token CSRF son rechazadas', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent } = await loginAgent(app, owner.email);

    const res = await agent.post('/api/org/departments').send({ name: 'Soporte' });
    expect(res.status).toBe(403);
  });
});

describe('Alcance de superadmin', () => {
  test('SUPERADMIN no puede usar los endpoints de organización (no tiene organizationId)', async () => {
    const passwordHash = await require('../src/lib/passwords').hashPassword('correct-horse-battery-staple');
    await prisma.user.create({
      data: { name: 'Superadmin', email: 'root@niro.test', role: 'SUPERADMIN', passwordHash, organizationId: null }
    });
    const { agent } = await loginAgent(app, 'root@niro.test');

    const res = await agent.get('/api/org');
    expect(res.status).toBe(403);
  });

  test('un OWNER de organización no puede usar los endpoints de superadmin', async () => {
    const org = await createOrganization(prisma, { slug: 'acme' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@acme.test', role: 'OWNER' });
    const { agent } = await loginAgent(app, owner.email);

    const res = await agent.get('/api/superadmin/organizations');
    expect(res.status).toBe(403);
  });
});
