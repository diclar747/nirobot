const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `ar-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@ar.test`, role: 'OWNER' });
  const caja = await prisma.department.create({ data: { organizationId: org.id, name: 'Caja' } });
  const rrhh = await prisma.department.create({ data: { organizationId: org.id, name: 'Recursos Humanos' } });
  return { org, owner, caja, rrhh, admin: await loginAgent(app, owner.email) };
}
const post = (s, path, body) => s.agent.post(path).set('X-CSRF-Token', s.csrfToken).send(body);
const patch = (s, path, body) => s.agent.patch(path).set('X-CSRF-Token', s.csrfToken).send(body);

describe('Áreas de los usuarios', () => {
  test('al crear un usuario se le asignan áreas y aparecen en la lista', async () => {
    const { admin, caja, rrhh } = await setup();
    const juan = await post(admin, '/api/org/users', { name: 'Juan Pérez', email: 'juan@ar.test', role: 'AGENT', departmentIds: [caja.id] });
    expect(juan.status).toBe(201);
    expect(juan.body.user.departments.map((d) => d.name)).toEqual(['Caja']);
    const carlos = await post(admin, '/api/org/users', { name: 'Carlos Gómez', email: 'carlos@ar.test', role: 'AGENT', departmentIds: [rrhh.id] });
    expect(carlos.body.user.departments.map((d) => d.name)).toEqual(['Recursos Humanos']);

    const list = await admin.agent.get('/api/org/users');
    const byName = Object.fromEntries(list.body.users.map((u) => [u.name, u.departments.map((d) => d.name)]));
    expect(byName['Juan Pérez']).toEqual(['Caja']);
    expect(byName['Carlos Gómez']).toEqual(['Recursos Humanos']);
    const depts = await admin.agent.get('/api/org/departments'); // y el área lo refleja
    expect(depts.body.departments.find((d) => d.name === 'Caja').members.map((m) => m.name)).toEqual(['Juan Pérez']);
  });

  test('editar reemplaza las áreas; una lista vacía quita todas', async () => {
    const { admin, caja, rrhh } = await setup();
    const u = await post(admin, '/api/org/users', { name: 'Ana Ruiz', email: 'ana@ar.test', role: 'AGENT', departmentIds: [caja.id] });
    const id = u.body.user.id;
    const both = await patch(admin, `/api/org/users/${id}`, { departmentIds: [caja.id, rrhh.id] });
    expect(both.status).toBe(200);
    expect(both.body.user.departments.map((d) => d.name).sort()).toEqual(['Caja', 'Recursos Humanos']);
    const onlyRrhh = await patch(admin, `/api/org/users/${id}`, { departmentIds: [rrhh.id], name: 'Ana R.' });
    expect(onlyRrhh.body.user.departments.map((d) => d.name)).toEqual(['Recursos Humanos']);
    expect(onlyRrhh.body.user.name).toBe('Ana R.');
    const none = await patch(admin, `/api/org/users/${id}`, { departmentIds: [] });
    expect(none.body.user.departments).toEqual([]);
  });

  test('no se pueden asignar áreas de otra organización', async () => {
    const { admin } = await setup();
    const other = await createOrganization(prisma, { slug: `ar2-${Date.now()}` });
    const foreign = await prisma.department.create({ data: { organizationId: other.id, name: 'Ajena' } });
    const res = await post(admin, '/api/org/users', { name: 'Pedro Sosa', email: 'pedro@ar.test', role: 'AGENT', departmentIds: [foreign.id] });
    expect(res.status).toBe(404);
  });

  test('nunca se puede crear ni ascender a un superadmin desde una organización', async () => {
    const { admin, owner } = await setup();
    expect((await post(admin, '/api/org/users', { name: 'Falso Root', email: 'root@ar.test', role: 'SUPERADMIN' })).status).toBe(400);
    const u = await post(admin, '/api/org/users', { name: 'Luis Vera', email: 'luis@ar.test', role: 'AGENT' });
    expect((await patch(admin, `/api/org/users/${u.body.user.id}`, { role: 'SUPERADMIN' })).status).toBe(400);
    expect(owner.role).toBe('OWNER');
  });

  test('un agente ve los chats de su área (y no los de otra)', async () => {
    const { admin, org, caja, rrhh } = await setup();
    const juan = await post(admin, '/api/org/users', { name: 'Juan', email: 'juan2@ar.test', role: 'AGENT', password: 'correct-horse-battery-staple', departmentIds: [caja.id] });
    await prisma.user.update({ where: { id: juan.body.user.id }, data: { mustChangePassword: false } });
    const c1 = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente Caja', phone: '595981000001' } });
    const c2 = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente RRHH', phone: '595981000002' } });
    await prisma.conversation.create({ data: { organizationId: org.id, contactId: c1.id, departmentId: caja.id, channel: 'whatsapp' } });
    await prisma.conversation.create({ data: { organizationId: org.id, contactId: c2.id, departmentId: rrhh.id, channel: 'whatsapp' } });
    const agent = await loginAgent(app, 'juan2@ar.test');
    const list = await agent.agent.get('/api/org/conversations');
    expect(list.body.conversations.map((c) => c.contact.name)).toEqual(['Cliente Caja']);
  });
});
