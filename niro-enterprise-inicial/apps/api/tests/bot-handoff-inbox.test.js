const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

const node = (id, type, data = {}) => ({ id, type, title: id, description: '', position: { x: 0, y: 0 }, data });

// Menú: "1" → área Compras (y, si se indica, a un agente puntual), como lo arma el botón "Menú por áreas".
function areaMenuFlow(departmentId, userId = '') {
  return {
    version: 1, name: 'Áreas', enabled: true, published: true,
    nodes: [
      node('start', 'start'),
      node('menu', 'menu', {
        text: '¿Con qué área querés hablar?',
        options: [{ key: '1', label: 'Compras', departmentId, userId, message: 'Te paso con Compras. En un momento te atienden.' }]
      }),
      node('end', 'end')
    ],
    edges: [{ id: 'e0', from: 'start', to: 'menu', label: '' }, { id: 'e1', from: 'menu', to: 'end', label: '' }]
  };
}

async function setup({ memberOfCompras = true, assignToAna = false, flowFor = null } = {}) {
  const org = await createOrganization(prisma, { slug: 'handoff-inbox' });
  const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@handoff.test', role: 'OWNER' });
  const ana = await createUser(prisma, { organizationId: org.id, email: 'ana@handoff.test', role: 'AGENT' });
  const compras = await prisma.department.create({ data: { organizationId: org.id, name: 'Compras' } });
  if (memberOfCompras) await prisma.departmentMember.create({ data: { departmentId: compras.id, userId: ana.id } });
  const botFlow = flowFor ? flowFor({ compras, ana }) : areaMenuFlow(compras.id, assignToAna ? ana.id : '');
  await prisma.organizationSettings.update({ where: { organizationId: org.id }, data: { botFlow } });
  return { org, owner, ana, compras };
}

describe('Derivación del bot a un área: ¿le llega al agente?', () => {
  test('el agente del área ve el chat, lo acepta y el cliente recibe el saludo con su nombre', async () => {
    const { owner, ana, compras } = await setup();
    const client = await loginAgent(app, owner.email);

    // Un cliente escribe (conversación sin asignar) y elige la opción 1.
    const conv = await client.agent.post('/api/org/conversations').set('X-CSRF-Token', client.csrfToken).send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;
    await client.agent.post(`/api/org/conversations/${id}/messages`).set('X-CSRF-Token', client.csrfToken).send({ content: '1', type: 'inbound' });

    const routed = await prisma.conversation.findUnique({ where: { id } });
    expect(routed.departmentId).toBe(compras.id);
    expect(routed.tags).toContain('Derivado');
    expect(routed.assignedToId).toBeNull();

    // La agente de Compras entra: el chat tiene que aparecer en su bandeja.
    const anaSession = await loginAgent(app, ana.email);
    const list = await anaSession.agent.get('/api/org/conversations');
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((c) => c.id)).toContain(id);

    // Acepta la transferencia y el cliente recibe el saludo del agente.
    const accept = await anaSession.agent.post(`/api/org/conversations/${id}/transfer-response`).set('X-CSRF-Token', anaSession.csrfToken).send({ action: 'accept' });
    expect(accept.status).toBe(200);

    const messages = await prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } });
    const texts = messages.map((m) => m.content);
    expect(texts.join('\n')).toContain('Te paso con Compras.');
    expect(texts.some((t) => t.includes('Bienvenido') && t.includes(ana.name.split(' ')[0]))).toBe(true);
    expect((await prisma.conversation.findUnique({ where: { id } })).assignedToId).toBe(ana.id);
  });

  test('con agente puntual en la opción: el chat le queda asignado y recibe la transferencia', async () => {
    const { owner, ana, compras } = await setup({ assignToAna: true });
    const client = await loginAgent(app, owner.email);
    const conv = await client.agent.post('/api/org/conversations').set('X-CSRF-Token', client.csrfToken).send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;
    await client.agent.post(`/api/org/conversations/${id}/messages`).set('X-CSRF-Token', client.csrfToken).send({ content: '1', type: 'inbound' });

    const routed = await prisma.conversation.findUnique({ where: { id } });
    expect(routed.assignedToId).toBe(ana.id);
    expect(routed.departmentId).toBe(compras.id);
    expect(routed.status).toBe('OPEN');

    const anaSession = await loginAgent(app, ana.email);
    const detail = await anaSession.agent.get(`/api/org/conversations/${id}`);
    expect(detail.status).toBe(200);
    // La nota de transferencia queda guardada: la tarjeta "Aceptar / Rechazar" aparece al abrir el chat,
    // aunque el agente no estuviera conectado en ese momento.
    expect(detail.body.messages.some((m) => m.direction === 'NOTE' && m.content.includes('[TRANSFERENCIA]'))).toBe(true);

    const accept = await anaSession.agent.post(`/api/org/conversations/${id}/transfer-response`).set('X-CSRF-Token', anaSession.csrfToken).send({ action: 'accept' });
    expect(accept.status).toBe(200);
    const texts = (await prisma.message.findMany({ where: { conversationId: id } })).map((m) => m.content).join('\n');
    expect(texts).toContain('Bienvenido');
  });

  test('el bloque CRM aplica etapa y etiquetas, y el de agente deriva al área', async () => {
    const flowFor = ({ compras }) => ({
      version: 1, name: 'CRM + agente', enabled: true, published: true,
      nodes: [
        node('start', 'start'),
        node('crm', 'crm', { stage: 'interesados', tags: ['Bot', 'Compras'] }),
        node('agent', 'agent', { departmentId: compras.id, message: 'Te paso con el equipo de Compras.' })
      ],
      edges: [{ id: 'e0', from: 'start', to: 'crm', label: '' }, { id: 'e1', from: 'crm', to: 'agent', label: '' }]
    });
    const { owner, ana, compras } = await setup({ flowFor });
    const client = await loginAgent(app, owner.email);
    const conv = await client.agent.post('/api/org/conversations').set('X-CSRF-Token', client.csrfToken).send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;

    const routed = await prisma.conversation.findUnique({ where: { id } });
    expect(routed.departmentId).toBe(compras.id);
    expect(routed.tags).toEqual(expect.arrayContaining(['Interesados', 'Bot', 'Compras', 'Derivado']));
    expect(routed.status).toBe('OPEN');

    const anaSession = await loginAgent(app, ana.email);
    const list = await anaSession.agent.get('/api/org/conversations');
    expect(list.body.conversations.map((c) => c.id)).toContain(id);
  });

  test('un agente que NO es del área no ve el chat', async () => {
    const { owner, ana } = await setup({ memberOfCompras: false });
    const client = await loginAgent(app, owner.email);
    const conv = await client.agent.post('/api/org/conversations').set('X-CSRF-Token', client.csrfToken).send({ newContact: { name: 'Cliente' } });
    const id = conv.body.conversation.id;
    await client.agent.post(`/api/org/conversations/${id}/messages`).set('X-CSRF-Token', client.csrfToken).send({ content: '1', type: 'inbound' });

    const anaSession = await loginAgent(app, ana.email);
    const list = await anaSession.agent.get('/api/org/conversations');
    expect(list.body.conversations.map((c) => c.id)).not.toContain(id);
  });
});
