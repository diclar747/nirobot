// Flujos de bot de prueba (el único bot que existe: el editor de /bot).
function node(id, type, data = {}) {
  return { id, type, title: id, description: '', position: { x: 0, y: 0 }, data };
}

function flow(nodes, edges) {
  return {
    version: 1,
    name: 'Flujo de prueba',
    enabled: true,
    published: true,
    nodes: [node('start', 'start'), ...nodes],
    edges: edges.map(([from, to, label = ''], i) => ({ id: `e${i}`, from, to, label }))
  };
}

// Inicio → bloque IA (responde con IA cualquier mensaje mientras nadie tome el chat).
function aiFlow(prompt = '') {
  return flow([node('ai', 'ai', { prompt })], [['start', 'ai']]);
}

// Inicio → bienvenida (solo al iniciar) → menú; si no elige una opción válida sigue por "No coincide" a la IA (si aiFallback).
function menuFlow({ welcome = 'Hola, bienvenido', options = [], aiFallback = false } = {}) {
  const nodes = [node('welcome', 'message', { text: welcome, onlyOnNew: true }), node('menu', 'menu', { text: '¿Con qué área querés hablar?', options })];
  const edges = [['start', 'welcome'], ['welcome', 'menu']];
  if (aiFallback) {
    nodes.push(node('ai', 'ai', {}));
    edges.push(['menu', 'ai', 'No coincide']);
  }
  return flow(nodes, edges);
}

module.exports = { aiFlow, menuFlow };
