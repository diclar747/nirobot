const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() + 3600000), billingExempt: true } });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}${Math.random().toString(36).slice(2, 6)}@hist.test`, role: 'OWNER' });
  const agentUser = await createUser(prisma, { organizationId: org.id, email: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}@hist.test`, role: 'AGENT' });
  const dept = await prisma.department.create({ data: { organizationId: org.id, name: 'Ventas' } });
  await prisma.departmentMember.create({ data: { departmentId: dept.id, userId: agentUser.id } });

  const ana = await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana Cliente', phone: '595981000001' } });
  const beto = await prisma.contact.create({ data: { organizationId: org.id, name: 'Beto Cliente', phone: '595981000002' } });
  const convAna = await prisma.conversation.create({ data: { organizationId: org.id, contactId: ana.id, channel: 'whatsapp', departmentId: dept.id, assignedToId: agentUser.id } });
  const convBeto = await prisma.conversation.create({ data: { organizationId: org.id, contactId: beto.id, channel: 'whatsapp' } });

  // Ana: 1 recibido, 1 respondido por el agente (entregado), 1 imagen fallida.
  await prisma.message.create({ data: { conversationId: convAna.id, direction: 'INBOUND', content: 'Hola, tengo una consulta', deliveryStatus: 'sent' } });
  await prisma.message.create({ data: { conversationId: convAna.id, direction: 'OUTBOUND', senderUserId: agentUser.id, content: 'Claro, decime', deliveryStatus: 'delivered' } });
  await prisma.message.create({ data: { conversationId: convAna.id, direction: 'OUTBOUND', contentType: 'image-failed', content: '🖼️ Imagen', deliveryStatus: 'failed' } });

  // Beto (fuera del área del agente): 1 mensaje de campaña, visto.
  const campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: 'Promo Septiembre', message: 'Oferta', status: 'COMPLETED', createdByUserId: owner.id } });
  await prisma.message.create({ data: { conversationId: convBeto.id, direction: 'OUTBOUND', campaignId: campaign.id, content: 'Oferta especial', deliveryStatus: 'read' } });

  return { org, owner, agentUser, dept, ana, beto, convAna, convBeto, campaign, admin: await loginAgent(app, owner.email), agentSession: await loginAgent(app, agentUser.email) };
}

describe('Historial de mensajes', () => {
  test('el resumen cuenta por dirección, estado, origen y tipo', async () => {
    const { admin } = await setup();
    const res = await admin.agent.get('/api/org/history/summary');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.outbound).toBe(3);
    expect(res.body.inbound).toBe(1);
    expect(res.body.byStatus).toMatchObject({ delivered: 1, failed: 1, read: 1 });
    expect(res.body.fromAgents).toBe(1);
    expect(res.body.fromCampaigns).toBe(1);
    expect(res.body.byType.image).toBe(1);
  });

  test('la lista trae contacto, agente, origen y se puede filtrar por dirección/estado/tipo/origen', async () => {
    const { admin } = await setup();
    const all = await admin.agent.get('/api/org/history/messages');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(4);
    const withAgent = all.body.messages.find((m) => m.agent);
    expect(withAgent.agent.name).toBeTruthy();
    expect(withAgent.origin).toBe('agent');
    expect(withAgent.contact.name).toBe('Ana Cliente');

    const failedOnly = await admin.agent.get('/api/org/history/messages?status=failed');
    expect(failedOnly.body.total).toBe(1);
    expect(failedOnly.body.messages[0].contentType).toBe('image-failed');

    const campaignOnly = await admin.agent.get('/api/org/history/messages?origin=campaign');
    expect(campaignOnly.body.total).toBe(1);
    expect(campaignOnly.body.messages[0].campaign.name).toBe('Promo Septiembre');

    const inboundOnly = await admin.agent.get('/api/org/history/messages?direction=INBOUND');
    expect(inboundOnly.body.total).toBe(1);
  });

  test('el detalle de un mensaje incluye reacciones y transcripción', async () => {
    const { admin, convAna } = await setup();
    const list = await admin.agent.get('/api/org/history/messages?status=delivered');
    const id = list.body.messages[0].id;
    const detail = await admin.agent.get(`/api/org/history/messages/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.message.reactions).toEqual([]);
    expect(detail.body.message.conversationId).toBe(convAna.id);
    expect(detail.body.message.content).toBe('Claro, decime');
  });

  test('un agente solo ve el historial de su área/asignación, no el de otras conversaciones', async () => {
    const { agentSession } = await setup();
    const res = await agentSession.agent.get('/api/org/history/messages');
    expect(res.status).toBe(200);
    // Solo los 3 mensajes de la conversación de Ana (asignada a este agente) — no el de Beto/campaña.
    expect(res.body.total).toBe(3);
    expect(res.body.messages.every((m) => m.contact.name === 'Ana Cliente')).toBe(true);

    const summary = await agentSession.agent.get('/api/org/history/summary');
    expect(summary.body.fromCampaigns).toBe(0);
  });

  test('exportar CSV respeta los filtros y no choca con la ruta de detalle', async () => {
    const { admin } = await setup();
    const res = await admin.agent.get('/api/org/history/messages/export.csv?status=read');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Oferta especial');
    expect(res.text).not.toContain('Hola, tengo una consulta');
  });

  test('sin el permiso "history" no se puede entrar', async () => {
    const { agentUser, agentSession } = await setup();
    await prisma.user.update({ where: { id: agentUser.id }, data: { permissions: { history: false } } });
    const res = await agentSession.agent.get('/api/org/history/messages');
    expect(res.status).toBe(403);
  });
});
