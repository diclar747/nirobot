const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `ww-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}${Math.random().toString(36).slice(2, 6)}@ww.test`, role: 'OWNER' });
  return { org, admin: await loginAgent(app, owner.email) };
}
const post = (s, path, body) => s.agent.post(path).set('X-CSRF-Token', s.csrfToken).send(body);

describe('Bienvenida por WhatsApp al crear un usuario', () => {
  test('con teléfono y WhatsApp conectado, se manda el mensaje con usuario y contraseña', async () => {
    const { admin } = await setup();
    const sendTextSpy = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('wa-welcome-1');

    const res = await post(admin, '/api/org/users', { name: 'Ana Agente', email: 'ana@ww.test', role: 'AGENT', phone: '595981234567' });

    expect(res.status).toBe(201);
    expect(res.body.user.phone).toBe('595981234567');
    expect(res.body.whatsappWelcome).toEqual({ sent: true });
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    const [orgId, phone, message] = sendTextSpy.mock.calls[0];
    expect(phone).toBe('595981234567');
    expect(message).toContain('ana@ww.test');
    expect(message).toContain(res.body.temporaryPassword);
    expect(typeof orgId).toBe('string');
  });

  test('con teléfono pero WhatsApp desconectado, el usuario se crea igual y se informa el error', async () => {
    const { admin } = await setup();
    jest.spyOn(whatsapp, 'sendText').mockRejectedValue(new Error('WhatsApp no esta conectado para esta organizacion'));

    const res = await post(admin, '/api/org/users', { name: 'Beto Agente', email: 'beto@ww.test', role: 'AGENT', phone: '595981234000' });

    expect(res.status).toBe(201);
    expect(res.body.whatsappWelcome).toEqual({ sent: false, error: 'WhatsApp no esta conectado para esta organizacion' });
  });

  test('sin teléfono, no se intenta mandar nada', async () => {
    const { admin } = await setup();
    const sendTextSpy = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('should-not-be-called');

    const res = await post(admin, '/api/org/users', { name: 'Carla Agente', email: 'carla@ww.test', role: 'AGENT' });

    expect(res.status).toBe(201);
    expect(res.body.user.phone).toBeNull();
    expect(res.body.whatsappWelcome).toBeNull();
    expect(sendTextSpy).not.toHaveBeenCalled();
  });
});
