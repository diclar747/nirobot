const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('Reportes: series diarias, tendencias y mapa de calor', () => {
  test('devuelve una fila por día (también los vacíos), la variación y el mapa por hora', async () => {
    const org = await createOrganization(prisma, { slug: 'reports-series' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@reports.test', role: 'OWNER' });
    const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000123' } });

    // Período actual (últimos 7 días) y el anterior, para que la comparación tenga sentido.
    const conv = async (when) => prisma.conversation.create({ data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', createdAt: when, updatedAt: when } });
    const hoy = await conv(daysAgo(1));
    await conv(daysAgo(2));
    await conv(daysAgo(9));   // período anterior

    await prisma.message.createMany({ data: [
      { conversationId: hoy.id, direction: 'INBOUND', content: 'hola', createdAt: daysAgo(1) },
      { conversationId: hoy.id, direction: 'OUTBOUND', content: 'buenas', createdAt: daysAgo(1) },
      { conversationId: hoy.id, direction: 'NOTE', content: 'nota interna', createdAt: daysAgo(1) }
    ] });

    const { agent } = await loginAgent(app, owner.email);
    const res = await agent.get('/api/org/reports/summary?days=7');
    expect(res.status).toBe(200);

    expect(res.body.series).toHaveLength(7);
    const conDatos = res.body.series.filter((d) => d.conversations > 0);
    expect(conDatos).toHaveLength(2);
    const dia = res.body.series.find((d) => d.inbound > 0);
    expect(dia.inbound).toBe(1);
    expect(dia.outbound).toBe(1); // la nota interna no cuenta

    // 2 conversaciones ahora contra 1 antes = +100%
    expect(res.body.trends.conversations).toBe(100);
    expect(res.body.previous.conversations).toBe(1);

    expect(Array.isArray(res.body.heatmap)).toBe(true);
    expect(res.body.heatmap.reduce((sum, cell) => sum + cell.total, 0)).toBe(1);
    expect(res.body.heatmap[0]).toHaveProperty('weekday');
    expect(res.body.heatmap[0]).toHaveProperty('hour');
  });

  test('sin datos previos la variación es null (no "+100%" desde cero)', async () => {
    const org = await createOrganization(prisma, { slug: 'reports-series-2' });
    const owner = await createUser(prisma, { organizationId: org.id, email: 'owner2@reports.test', role: 'OWNER' });
    const { agent } = await loginAgent(app, owner.email);
    const res = await agent.get('/api/org/reports/summary?days=14');
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(14);
    expect(res.body.trends.conversations).toBeNull();
    expect(res.body.heatmap).toEqual([]);
  });
});
