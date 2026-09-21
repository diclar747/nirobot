const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

const del = (s, path) => s.agent.delete(path).set('X-CSRF-Token', s.csrfToken);

async function setup() {
  const org = await createOrganization(prisma, { slug: `ud-${Date.now()}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@ud.test`, role: 'OWNER' });
  const agent = await createUser(prisma, { organizationId: org.id, email: `a${Date.now()}@ud.test`, role: 'AGENT' });
  return { org, owner, agent, session: await loginAgent(app, owner.email) };
}

describe('Eliminar usuarios', () => {
  test('elimina al agente y conserva sus chats sin asignar', async () => {
    const { org, agent, session } = await setup();
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'C', phone: '595981000009' } });
    const conv = await prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', assignedToId: agent.id } });
    const res = await del(session, `/api/org/users/${agent.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: agent.id } })).toBeNull();
    expect((await prisma.conversation.findUnique({ where: { id: conv.id } })).assignedToId).toBeNull();
    expect(await prisma.auditLog.findFirst({ where: { action: 'user.deleted', entityId: agent.id } })).toBeTruthy();
  });

  test('no permite eliminarse a sí mismo, ni a usuarios de otra organización', async () => {
    const { owner, session } = await setup();
    expect((await del(session, `/api/org/users/${owner.id}`)).status).toBe(400);
    const other = await createOrganization(prisma, { slug: `ud2-${Date.now()}` });
    const stranger = await createUser(prisma, { organizationId: other.id, email: `s${Date.now()}@ud.test`, role: 'AGENT' });
    expect((await del(session, `/api/org/users/${stranger.id}`)).status).toBe(404);
    expect(await prisma.user.findUnique({ where: { id: stranger.id } })).toBeTruthy();
  });

  test('un administrador no puede eliminar a un propietario y un agente no puede eliminar a nadie', async () => {
    const { org, owner, agent } = await setup();
    const admin = await createUser(prisma, { organizationId: org.id, email: `ad${Date.now()}@ud.test`, role: 'ADMIN' });
    const adminSession = await loginAgent(app, admin.email);
    expect((await del(adminSession, `/api/org/users/${owner.id}`)).status).toBe(403);
    const agentSession = await loginAgent(app, agent.email);
    expect((await del(agentSession, `/api/org/users/${admin.id}`)).status).toBe(403);
  });
});
