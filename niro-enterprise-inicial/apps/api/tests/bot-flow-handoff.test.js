const { runBotFlow, conversationUpdateData, HANDOFF_TAG } = require('../src/lib/botFlow');

const node = (id, type, data = {}) => ({ id, type, title: id, description: '', position: { x: 0, y: 0 }, data });
const edge = (from, to, label = '') => ({ id: `${from}-${to}-${label}`, from, to, label });

// Bienvenida → ¿ventas? → agente(Ventas) | ¿compras? → agente(Compras) | IA
const flow = {
  version: 1, name: 'Áreas', enabled: true, published: true,
  nodes: [
    node('start', 'start'),
    node('welcome', 'message', { text: 'Hola {{nombre}}. 1 Ventas, 2 Compras', onlyOnNew: true }),
    node('kw-ventas', 'keyword', { keywords: ['1', 'ventas', 'cotización'], response: '' }),
    node('ag-ventas', 'agent', { departmentId: 'dep-ventas', message: 'Te paso con Ventas.' }),
    node('kw-compras', 'keyword', { keywords: ['2', 'compras'], response: '' }),
    node('ag-compras', 'agent', { departmentId: 'dep-compras', userId: 'user-ana', message: 'Te paso con Compras.' }),
    node('ai', 'ai', { prompt: 'Ayudá' }),
    node('end', 'end')
  ],
  edges: [
    edge('start', 'welcome'), edge('welcome', 'kw-ventas'),
    edge('kw-ventas', 'ag-ventas', 'Coincide'), edge('kw-ventas', 'kw-compras', 'No coincide'),
    edge('kw-compras', 'ag-compras', 'Coincide'), edge('kw-compras', 'ai', 'No coincide'),
    edge('ai', 'end')
  ]
};
const contact = { name: 'María López', phone: '595981000000' };
const run = (content, extra = {}) => runBotFlow(flow, { content, contact, isNewConversation: false, ...extra });

describe('Bot: derivar a un agente o departamento', () => {
  test('"ventas" deriva al departamento de Ventas con aviso y sin IA', () => {
    const r = run('Quiero ventas');
    expect(r.conversation.departmentId).toBe('dep-ventas');
    expect(r.replies).toEqual(['Te paso con Ventas.']);
    expect(r.useAi).toBe(false);
  });

  test('cotización con tilde o sin tilde coincide', () => {
    expect(run('necesito una COTIZACION').conversation.departmentId).toBe('dep-ventas');
    expect(run('cotización por favor').conversation.departmentId).toBe('dep-ventas');
  });

  test('menú por números: "2" deriva a Compras y a la persona indicada; "12" o "tengo 2 dudas" no', () => {
    const r = run('2');
    expect(r.conversation).toMatchObject({ departmentId: 'dep-compras', assignedToId: 'user-ana', handoff: true });
    expect(run('2.').conversation.departmentId).toBe('dep-compras');
    expect(run('tengo 2 dudas').conversation.departmentId).toBeUndefined();
    expect(run('12').conversation.departmentId).toBeUndefined();
  });

  test('una palabra clave no coincide dentro de otra palabra', () => {
    expect(run('conventas').useAi).toBe(true);
  });

  test('si nada coincide, responde la IA', () => {
    const r = run('¿tienen envío a domicilio?');
    expect(r.useAi).toBe(true);
    expect(r.conversation.departmentId).toBeUndefined();
  });

  test('en el primer mensaje saluda y también deriva si ya pidió un área', () => {
    const r = run('ventas', { isNewConversation: true });
    expect(r.replies[0]).toBe('Hola María. 1 Ventas, 2 Compras');
    expect(r.replies).toContain('Te paso con Ventas.');
    expect(r.conversation.departmentId).toBe('dep-ventas');
  });

  test('al derivar deja la etiqueta "Derivado" y abre el chat', () => {
    const r = run('ventas');
    const data = conversationUpdateData({ tags: ['Bot'], status: 'PENDING' }, r);
    expect(data.tags).toContain(HANDOFF_TAG);
    expect(data.status).toBe('OPEN');
    expect(data.departmentId).toBe('dep-ventas');
  });

  test('el bot no vuelve a hablar si un agente tomó el chat o ya fue derivado', () => {
    expect(run('ventas', { conversation: { assignedToId: 'user-x', tags: [] } })).toBeNull();
    expect(run('ventas', { conversation: { assignedToId: null, tags: [HANDOFF_TAG] } })).toBeNull();
    expect(run('ventas', { conversation: { assignedToId: null, tags: [] } })).not.toBeNull();
  });
});

describe('Bot: bloque "Menú de opciones"', () => {
  const menuFlow = (extra = {}) => ({
    version: 1, name: 'Menú', enabled: true, published: true,
    nodes: [
      node('start', 'start'),
      node('menu', 'menu', {
        text: 'Hola {{nombre}}, elegí una opción:',
        options: [
          { key: '1', label: 'Ventas', departmentId: 'dep-ventas', message: 'Te paso con Ventas.' },
          { key: '3', label: 'Compras', keywords: ['proveedores'], departmentId: 'dep-compras', userId: 'user-ana', message: 'Te paso con Compras, {{nombre}}.' },
          { key: '5', label: 'Soporte técnico', departmentId: 'dep-soporte', message: '' }
        ],
        ...extra
      }),
      node('ai', 'ai', { prompt: 'Ayudá' }),
      node('end', 'end')
    ],
    edges: [edge('start', 'menu'), edge('menu', 'ai', 'No coincide'), edge('ai', 'end')]
  });
  const go = (content, opts = {}, f = menuFlow()) => runBotFlow(f, { content, contact, isNewConversation: false, ...opts });

  test('cada número deriva a su departamento', () => {
    expect(go('1').conversation.departmentId).toBe('dep-ventas');
    expect(go('3').conversation).toMatchObject({ departmentId: 'dep-compras', assignedToId: 'user-ana', handoff: true });
    expect(go('5').conversation.departmentId).toBe('dep-soporte');
    expect(go('3').replies).toEqual(['Te paso con Compras, María.']);
  });

  test('acepta "opción 3", el nombre y palabras extra', () => {
    expect(go('opción 3').conversation.departmentId).toBe('dep-compras');
    expect(go('Opcion 5').conversation.departmentId).toBe('dep-soporte');
    expect(go('quiero soporte tecnico').conversation.departmentId).toBe('dep-soporte');
    expect(go('hablo con proveedores').conversation.departmentId).toBe('dep-compras');
  });

  test('un número que no es opción no deriva', () => {
    expect(go('2', { lastBotReply: 'Hola María, elegí una opción:\n1. Ventas\n3. Compras\n5. Soporte técnico' }, menuFlow({ fallbackLabel: 'x' })).replies[0]).toMatch(/Elegí una opción/);
    expect(go('13').conversation.departmentId).toBeUndefined();
  });

  // Quien escribe por segunda vez pero nunca vio el menú (p. ej. el flujo se publicó recién) recibe la presentación,
  // no un "No entendí tu respuesta" que no viene a cuento.
  // Caso visto en producción: el cliente saluda una y otra vez y recibía siempre "No entendí" (el propio
  // "No entendí" incluye la lista, así que el bot creía que acababa de mostrar el menú).
  test('a un saludo siempre se le responde con el saludo del menú', () => {
    const noEdge = { ...menuFlow(), edges: [edge('start', 'menu')] };
    const menu = go('hola', { lastBotReply: '' }, noEdge).replies[0];
    const invalid = go('xyz', { lastBotReply: menu }, noEdge).replies[0];
    expect(invalid).toContain('No entendí');
    for (const saludo of ['Hola', 'hola!', 'buenas', 'Buenas tardes', 'buen día']) {
      expect(go(saludo, { lastBotReply: invalid }, noEdge).replies[0]).toContain('elegí una opción:');
      expect(go(saludo, { lastBotReply: invalid }, noEdge).replies[0]).not.toContain('No entendí');
    }
  });

  test('si el menú no fue lo último que mandó el bot, lo presenta de nuevo (no dice "no entendí")', () => {
    const noEdge = { ...menuFlow(), edges: [edge('start', 'menu')] };
    const r = go('hola', { lastBotReply: 'Gracias por escribirnos.' }, noEdge);
    expect(r.replies[0]).toBe('Hola María, elegí una opción:\n1. Ventas\n3. Compras\n5. Soporte técnico');
  });

  test('primer mensaje: muestra el menú con las opciones numeradas', () => {
    const r = go('hola', { isNewConversation: true });
    expect(r.replies).toEqual(['Hola María, elegí una opción:\n1. Ventas\n3. Compras\n5. Soporte técnico']);
    expect(r.conversation.departmentId).toBeUndefined();
  });

  test('primer mensaje que ya es una opción: deriva sin repetir el menú', () => {
    const r = go('3', { isNewConversation: true });
    expect(r.conversation.departmentId).toBe('dep-compras');
    expect(r.replies).toEqual(['Te paso con Compras, María.']);
  });

  test('sin coincidencia en un chat en curso: sigue por "No coincide" (IA); sin esa salida, repite el menú', () => {
    expect(go('¿tienen envíos?').useAi).toBe(true);
    const noEdge = { ...menuFlow(), edges: [edge('start', 'menu')] };
    const r = go('¿tienen envíos?', { lastBotReply: 'Hola María, elegí una opción:\n1. Ventas\n3. Compras\n5. Soporte técnico' }, noEdge);
    expect(r.useAi).toBe(false);
    expect(r.replies[0]).toBe('No entendí tu respuesta. Elegí una opción:\n1. Ventas\n3. Compras\n5. Soporte técnico');
  });
});
