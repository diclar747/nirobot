const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { audit } = require('../src/lib/audit');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function setup() {
  const org = await createOrganization(prisma, { slug: `audit-page-${Date.now()}` });
  const owner = await createUser(prisma, { organizationId: org.id, email: `owner${Date.now()}@auditpage.test`, role: 'OWNER' });
  const ana = await createUser(prisma, { organizationId: org.id, email: `ana${Date.now()}@auditpage.test`, role: 'AGENT' });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { org, owner, ana, agent, csrfToken };
}

// Escribe N registros de auditoría con acciones/fechas variadas, para poder filtrar y paginar de verdad.
async function seedEntries(org, owner, ana) {
  const rows = [
    { actorUserId: owner.id, action: 'campaign.created', entityType: 'Campaign', entityId: 'c1', daysAgo: 0 },
    { actorUserId: owner.id, action: 'campaign.started', entityType: 'Campaign', entityId: 'c1', daysAgo: 0 },
    { actorUserId: ana.id, action: 'contact.deleted', entityType: 'Contact', entityId: 'ct1', daysAgo: 1 },
    { actorUserId: owner.id, action: 'department.created', entityType: 'Department', entityId: 'd1', daysAgo: 10, metadata: { name: 'Ventas' } },
    { actorUserId: null, action: 'superadmin.impersonate.start', entityType: 'User', entityId: 'u1', daysAgo: 20 }
  ];
  for (const row of rows) {
    await audit(prisma, { organizationId: org.id, actorUserId: row.actorUserId, action: row.action, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata || null });
    if (row.daysAgo > 0) {
      await prisma.auditLog.updateMany({
        where: { organizationId: org.id, action: row.action, entityId: row.entityId },
        data: { createdAt: new Date(Date.now() - row.daysAgo * 24 * 60 * 60 * 1000) }
      });
    }
  }
}

describe('Reportes: registro de auditoría con filtros y páginas', () => {
  test('pagina de a 15 por defecto e informa el total de páginas', async () => {
    const { org, owner, agent } = await setup();
    // loginAgent() ya dejó un "auth.login.success": se filtra por tipo para no depender de ese detalle.
    for (let i = 0; i < 22; i += 1) {
      await audit(prisma, { organizationId: org.id, actorUserId: owner.id, action: 'contact.created', entityType: 'Contact', entityId: `c${i}` });
    }
    const first = await agent.get('/api/org/reports/audit?entityType=Contact');
    expect(first.status).toBe(200);
    expect(first.body.entries).toHaveLength(15);
    expect(first.body.total).toBe(22);
    expect(first.body.totalPages).toBe(2);

    const second = await agent.get('/api/org/reports/audit?entityType=Contact&page=2');
    expect(second.body.entries).toHaveLength(7);
    // Ningún registro se repite entre páginas.
    const idsPage1 = first.body.entries.map((e) => e.id);
    const idsPage2 = second.body.entries.map((e) => e.id);
    expect(idsPage1.some((id) => idsPage2.includes(id))).toBe(false);
  });

  test('busca por texto en la acción, la entidad o el id', async () => {
    const { org, owner, ana, agent } = await setup();
    await seedEntries(org, owner, ana);
    const res = await agent.get('/api/org/reports/audit?q=contact');
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].action).toBe('contact.deleted');
  });

  test('filtra por rango de fechas', async () => {
    const { org, owner, ana, agent } = await setup();
    await seedEntries(org, owner, ana);
    const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await agent.get(`/api/org/reports/audit?from=${from}`);
    // Solo lo de hoy y de ayer entra (department.created de hace 10 días y superadmin de hace 20 quedan fuera).
    // loginAgent() del setup también cuenta como "hoy": se filtra por tipo de entidad para no depender de ese detalle.
    expect(res.body.entries.filter((e) => e.entityType !== 'RefreshToken' && e.action !== 'auth.login.success').map((e) => e.action).sort()).toEqual(['campaign.created', 'campaign.started', 'contact.deleted'].sort());
  });

  test('filtra por categoría (agrupa varias acciones)', async () => {
    const { org, owner, ana, agent } = await setup();
    await seedEntries(org, owner, ana);
    const res = await agent.get('/api/org/reports/audit?category=Campañas');
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries.every((e) => e.action.startsWith('campaign.'))).toBe(true);
  });

  test('filtra por tipo de entidad y por usuario (incluido "Sistema" para acciones sin actor)', async () => {
    const { org, owner, ana, agent } = await setup();
    await seedEntries(org, owner, ana);

    const byEntity = await agent.get('/api/org/reports/audit?entityType=Contact');
    expect(byEntity.body.entries).toHaveLength(1);

    const byActor = await agent.get(`/api/org/reports/audit?actorUserId=${ana.id}`);
    expect(byActor.body.entries.every((e) => e.actorName === ana.name)).toBe(true);
    expect(byActor.body.entries.length).toBeGreaterThan(0);

    const system = await agent.get('/api/org/reports/audit?actorUserId=system');
    expect(system.body.entries.every((e) => e.actorName === 'Sistema')).toBe(true);
    expect(system.body.entries.length).toBeGreaterThan(0);
  });

  test('los filtros disponibles reflejan solo lo de esta organización', async () => {
    const { org, owner, ana, agent } = await setup();
    await seedEntries(org, owner, ana);
    const otherOrg = await createOrganization(prisma, { slug: `audit-page-b-${Date.now()}` });
    await audit(prisma, { organizationId: otherOrg.id, actorUserId: null, action: 'sms.sent', entityType: 'SmsCampaign', entityId: 'x' });

    const res = await agent.get('/api/org/reports/audit/filters');
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(expect.arrayContaining(['Campañas', 'Contactos', 'Áreas']));
    expect(res.body.entityTypes).not.toContain('SmsCampaign');
    expect(res.body.actors.map((a) => a.id)).toEqual(expect.arrayContaining([owner.id, ana.id]));
  });

  test('cada fila trae los metadatos, para poder ver el detalle', async () => {
    const { org, owner, ana, agent } = await setup();
    await seedEntries(org, owner, ana);
    const res = await agent.get('/api/org/reports/audit?q=department');
    expect(res.body.entries[0].metadata).toEqual({ name: 'Ventas' });
  });
});
