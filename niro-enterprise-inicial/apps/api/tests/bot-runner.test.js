const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { menuFlow } = require('./helpers/flows');

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

function node(id, type, data = {}) {
  return { id, type, title: id, description: '', position: { x: 0, y: 0 }, data };
}

async function setup({ flow } = {}) {
  const org = await createOrganization(prisma, { slug: 'bot-runner' });
  const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@bot.test', role: 'OWNER' });
  const sales = await prisma.department.create({ data: { organizationId: org.id, name: 'Ventas' } });
  const support = await prisma.department.create({ data: { organizationId: org.id, name: 'Soporte' } });
  const botFlow = flow || menuFlow({
    welcome: 'Hola, soy Niro',
    options: [
      { key: '1', label: 'Ventas', departmentId: sales.id, message: 'Te paso con Ventas.' },
      { key: '2', label: 'Soporte', departmentId: support.id, message: 'Te paso con Soporte.' }
    ]
  });
  await prisma.organizationSettings.update({ where: { organizationId: org.id }, data: { botFlow } });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { org, owner, sales, support, agent, csrfToken };
}

async function newConversation(agent, csrfToken) {
  const res = await agent.post('/api/org/conversations').set('X-CSRF-Token', csrfToken).send({ newContact: { name: 'Cliente' } });
  expect(res.status).toBe(201);
  return res.body.conversation;
}

const send = (agent, csrfToken, conversationId, content) =>
  agent.post(`/api/org/conversations/${conversationId}/messages`).set('X-CSRF-Token', csrfToken).send({ content, type: 'inbound' });

describe('Motor del bot (un solo camino para todos los canales)', () => {
  test('elegir una opción del menú deriva al área, avisa al equipo y deja el chat abierto', async () => {
    const { agent, csrfToken, sales } = await setup();
    const conversation = await newConversation(agent, csrfToken);

    const res = await send(agent, csrfToken, conversation.id, '1');
    expect(res.status).toBe(201);

    const detail = await agent.get(`/api/org/conversations/${conversation.id}`);
    const texts = detail.body.messages.map((m) => m.content);
    expect(texts.join('\n')).toContain('Te paso con Ventas.');
    // Nota de transferencia para el equipo (antes faltaba en algunos caminos).
    expect(texts.some((t) => t.includes('[TRANSFERENCIA]'))).toBe(true);
    expect(detail.body.conversation.department?.id || detail.body.conversation.departmentId).toBe(sales.id);
    expect(detail.body.conversation.tags).toContain('Derivado');
    expect(detail.body.conversation.status).toBe('OPEN');
  });

  test('tras derivar, el bot deja de responder', async () => {
    const { agent, csrfToken } = await setup();
    const conversation = await newConversation(agent, csrfToken);
    await send(agent, csrfToken, conversation.id, '1');
    const before = (await agent.get(`/api/org/conversations/${conversation.id}`)).body.messages.length;

    await send(agent, csrfToken, conversation.id, 'hola de nuevo');
    const after = (await agent.get(`/api/org/conversations/${conversation.id}`)).body.messages;
    // Solo se suma el mensaje del cliente: ninguna respuesta del bot.
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].direction).toBe('INBOUND');
  });

  test('un bloque "Agente humano" deriva aunque sea el primer mensaje del cliente', async () => {
    const flow = {
      version: 1, name: 'Derivar directo', enabled: true, published: true,
      nodes: [node('start', 'start'), node('agent', 'agent', { message: 'Te paso con una persona del equipo.' })],
      edges: [{ id: 'e0', from: 'start', to: 'agent', label: '' }]
    };
    const { agent, csrfToken } = await setup({ flow });
    const conversation = await newConversation(agent, csrfToken);

    const detail = await agent.get(`/api/org/conversations/${conversation.id}`);
    const texts = detail.body.messages.map((m) => m.content).join('\n');
    expect(texts).toContain('Te paso con una persona del equipo.');
    expect(texts).toContain('[TRANSFERENCIA]');
    expect(detail.body.conversation.tags).toContain('Derivado');
  });

  test('las palabras clave responden y marcan la etapa del CRM', async () => {
    const flow = {
      version: 1, name: 'Palabras clave', enabled: true, published: true,
      nodes: [
        node('start', 'start'),
        node('kw', 'keyword', { keywords: ['precio', 'cotización'], response: 'Te ayudamos con tu cotización.', matchLabel: 'Coincide' }),
        node('crm', 'crm', { stage: 'interesados', tags: ['Bot'] })
      ],
      edges: [{ id: 'e0', from: 'start', to: 'kw', label: '' }, { id: 'e1', from: 'kw', to: 'crm', label: 'Coincide' }]
    };
    const { agent, csrfToken } = await setup({ flow });
    const conversation = await newConversation(agent, csrfToken);

    await send(agent, csrfToken, conversation.id, 'Hola, necesito una cotizacion');
    const detail = await agent.get(`/api/org/conversations/${conversation.id}`);
    expect(detail.body.messages.map((m) => m.content).join('\n')).toContain('Te ayudamos con tu cotización.');
    expect(detail.body.conversation.tags).toEqual(expect.arrayContaining(['Interesados', 'Bot']));
  });
});

test('la respuesta del bot guarda el id de WhatsApp (no se duplica con el eco del teléfono)', async () => {
  const whatsapp = require('../src/lib/whatsapp');
  const spy = jest.spyOn(whatsapp, 'sendText').mockResolvedValue('WA-123');
  const { prisma: db } = require('../src/lib/prisma');
  const { handleBotTurn } = require('../src/lib/botRunner');
  const org = await createOrganization(prisma, { slug: 'bot-echo' });
  const contact = await prisma.contact.create({ data: { organizationId: org.id, name: 'Cliente', phone: '595981000777' } });
  const conversation = await prisma.conversation.create({
    data: { organizationId: org.id, contactId: contact.id, channel: 'whatsapp', status: 'OPEN', tags: [] },
    include: require('../src/lib/conversations').CONVERSATION_INCLUDE
  });
  const settings = await prisma.organizationSettings.findUnique({ where: { organizationId: org.id } });
  await db.organizationSettings.update({
    where: { organizationId: org.id },
    data: { botFlow: { version: 1, name: 'Saludo', enabled: true, published: true, nodes: [node('start', 'start'), node('msg', 'message', { text: 'Hola, soy el bot.' })], edges: [{ id: 'e0', from: 'start', to: 'msg', label: '' }] } }
  });
  const fresh = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  await handleBotTurn({
    organizationId: org.id, conversation, contact, content: 'hola', isNewConversation: true,
    settings: fresh, deliver: (text) => whatsapp.sendText(org.id, contact.phone, text)
  });
  const stored = await prisma.message.findMany({ where: { conversationId: conversation.id } });
  expect(stored).toHaveLength(1);
  expect(stored[0].waMessageId).toBe('WA-123');
  void settings;
  spy.mockRestore();
});

describe('Simulador del constructor', () => {
  const simulate = (agent, csrfToken, message, state) =>
    agent.post('/api/org/bot-flow/test').set('X-CSRF-Token', csrfToken).send({ message, ...(state ? { state } : {}) });

  test('el primer mensaje se trata como conversación nueva: saluda y muestra el menú', async () => {
    const { agent, csrfToken } = await setup();
    const res = await simulate(agent, csrfToken, 'hola');
    expect(res.status).toBe(200);
    const all = res.body.replies.join('\n');
    expect(all).toContain('Hola, soy Niro');
    expect(all).toContain('1. Ventas');
    expect(res.body.state.started).toBe(true);
    expect(res.body.trace.map((step) => step.type)).toContain('menu');
  });

  test('elegir "2" deriva a Soporte y lo informa con el nombre del área', async () => {
    const { agent, csrfToken } = await setup();
    const first = await simulate(agent, csrfToken, 'hola');
    const res = await simulate(agent, csrfToken, '2', first.body.state);
    expect(res.body.handoff).toBe(true);
    expect(res.body.departmentName).toBe('Soporte');
    expect(res.body.replies.join('\n')).toContain('Te paso con Soporte.');
    expect(res.body.state.tags).toContain('Derivado');
  });

  test('después de derivar el simulador muestra que el bot ya no responde', async () => {
    const { agent, csrfToken } = await setup();
    const first = await simulate(agent, csrfToken, 'hola');
    const second = await simulate(agent, csrfToken, '1', first.body.state);
    const third = await simulate(agent, csrfToken, '¿hay alguien?', second.body.state);
    expect(third.body.silent).toBe(true);
    expect(third.body.silentReason).toBe('handoff');
    expect(third.body.replies).toEqual([]);
  });

  test('una opción inválida vuelve a mostrar el menú', async () => {
    const { agent, csrfToken } = await setup();
    const first = await simulate(agent, csrfToken, 'hola');
    const res = await simulate(agent, csrfToken, '9', first.body.state);
    expect(res.body.replies.join('\n')).toContain('1. Ventas');
    expect(res.body.handoff).toBe(false);
  });
});

// El caso que se vio en producción: en un chat viejo el cliente escribe "Hola" y recibía
// "No entendí tu respuesta" en vez del saludo, porque el bot había hablado alguna vez.
test('en un chat con historia, "Hola" recibe el saludo del menú (no "No entendí")', async () => {
  const { agent, csrfToken } = await setup();
  const conversation = await newConversation(agent, csrfToken);
  await send(agent, csrfToken, conversation.id, 'Hola');           // muestra el menú
  await send(agent, csrfToken, conversation.id, 'cualquier cosa');  // acá sí: "No entendí"
  const before = (await agent.get(`/api/org/conversations/${conversation.id}`)).body.messages.map((m) => m.content);
  expect(before[before.length - 1]).toContain('No entendí');

  // Pasa el tiempo (el último mensaje del bot deja de ser reciente) y el cliente vuelve a saludar.
  await prisma.message.updateMany({
    where: { conversationId: conversation.id },
    data: { createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000) }
  });
  await send(agent, csrfToken, conversation.id, 'Hola');
  const after = (await agent.get(`/api/org/conversations/${conversation.id}`)).body.messages.map((m) => m.content);
  expect(after[after.length - 1]).toContain('¿Con qué área querés hablar?');
  expect(after[after.length - 1]).not.toContain('No entendí');
});
