const mockWhatsapp = {
  getStatus: jest.fn(() => ({ status: 'disconnected', qr: null, phone: null })),
  sendText: jest.fn(),
  sendMedia: jest.fn()
};

jest.mock('../src/lib/whatsapp', () => mockWhatsapp);

const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const campaigns = require('../src/lib/campaigns');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
  mockWhatsapp.getStatus.mockReturnValue({ status: 'disconnected', qr: null, phone: null });
  // Cada test corre en milisegundos, no en los 30s/1.5s reales de producción.
  process.env.CAMPAIGN_RESUME_TIMEOUT_MS = '150';
  process.env.CAMPAIGN_RESUME_INTERVAL_MS = '20';
});

afterEach(() => {
  campaigns.clearAllTimers();
  delete process.env.CAMPAIGN_RESUME_TIMEOUT_MS;
  delete process.env.CAMPAIGN_RESUME_INTERVAL_MS;
});

async function setupStuckCampaign() {
  const org = await createOrganization(prisma, { slug: 'resume-co' });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner-${Date.now()}@resume.test`, role: 'OWNER' });
  const { agent, csrfToken } = await loginAgent(app, owner.email);

  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000000' } });

  const created = await agent
    .post('/api/org/campaigns')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Promo', message: 'Hola!', contactIds: [contact.id] });
  const campaignId = created.body.campaign.id;

  // Simula un proceso que murió a mitad de un envío: queda en SENDING sin timer activo (el
  // timer vivía en memoria y se perdió con el reinicio), con el destinatario aún pendiente.
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'SENDING', startedAt: new Date() } });

  return { org, campaignId, contactId: contact.id };
}

describe('Reanudar campañas que quedaron "enviando" tras un reinicio', () => {
  test('si WhatsApp ya está conectado, retoma el envío del destinatario pendiente', async () => {
    mockWhatsapp.getStatus.mockReturnValue({ status: 'connected', qr: null, phone: '595981000000' });
    mockWhatsapp.sendText.mockResolvedValue('wamid-123');

    const { campaignId, contactId } = await setupStuckCampaign();

    const resumedCount = await campaigns.resumeSendingCampaigns();
    expect(resumedCount).toBe(1);

    // El envío corre en segundo plano (espera a whatsapp.getStatus antes de mandar).
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(mockWhatsapp.sendText).toHaveBeenCalledTimes(1);
    const recipient = await prisma.campaignRecipient.findFirst({ where: { campaignId, contactId } });
    expect(recipient.status).toBe('SENT');
    expect(recipient.waMessageId).toBe('wamid-123');
  });

  test('si WhatsApp no reconecta a tiempo, no manda nada y deja al destinatario pendiente (sin marcarlo fallido)', async () => {
    // getStatus siempre "disconnected" (mock por defecto del beforeEach).
    const { campaignId, contactId } = await setupStuckCampaign();

    const resumedCount = await campaigns.resumeSendingCampaigns();
    expect(resumedCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(mockWhatsapp.sendText).not.toHaveBeenCalled();
    const recipient = await prisma.campaignRecipient.findFirst({ where: { campaignId, contactId } });
    expect(recipient.status).toBe('PENDING');
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(campaign.status).toBe('SENDING');
  });

  test('una campaña que no estaba en SENDING no se toca', async () => {
    const org = await createOrganization(prisma, { slug: 'resume-co-2' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@resume2.test', role: 'OWNER' });
    const { agent, csrfToken } = await loginAgent(app, owner.email);
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000001' } });
    await agent.post('/api/org/campaigns').set('X-CSRF-Token', csrfToken).send({ name: 'Borrador', message: 'Hola', contactIds: [contact.id] });

    const resumedCount = await campaigns.resumeSendingCampaigns();
    expect(resumedCount).toBe(0);
    expect(mockWhatsapp.sendText).not.toHaveBeenCalled();
  });
});
