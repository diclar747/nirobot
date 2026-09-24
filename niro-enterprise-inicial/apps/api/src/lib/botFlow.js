const CRM_STAGE_TAGS = {
  abiertas: 'Abiertas',
  pendientes: 'Pendientes',
  clientes: 'Clientes',
  interesados: 'Interesados',
  cerradas: 'Cerradas'
};

// Flujo inicial vacío (sin textos de ejemplo): el usuario arma el suyo.
function defaultBotFlow() {
  return {
    version: 1,
    name: 'Atención al cliente',
    enabled: false,
    published: false,
    nodes: [
      { id: 'start', type: 'start', title: 'Inicio', description: 'Entrada de cada conversación', position: { x: 30, y: 30 }, data: {} }
    ],
    edges: []
  };
}

function normalizeFlow(flow) {
  if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) return defaultBotFlow();
  return {
    version: Number(flow.version) || 1,
    name: String(flow.name || 'Flujo de atención'),
    enabled: flow.enabled === true,
    published: flow.published === true,
    nodes: flow.nodes,
    edges: flow.edges
  };
}

function getNextNodeId(edges, nodeId, label) {
  const outgoing = edges.filter((edge) => edge.from === nodeId);
  if (label) {
    const labeled = outgoing.find((edge) => String(edge.label || '').toLowerCase() === String(label).toLowerCase());
    if (labeled) return labeled.to;
  }
  return outgoing.find((edge) => !edge.label)?.to || outgoing[0]?.to || null;
}

// Sin tildes ni mayúsculas: "Cotización" coincide con "cotizacion".
function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

// Una palabra clave numérica ("1", "2") solo coincide si el cliente escribió exactamente eso (menú por números).
// Las demás coinciden si aparecen como palabra dentro del mensaje.
function keywordMatches(text, keyword) {
  if (!keyword) return false;
  if (/^\d+$/.test(keyword)) return text === keyword || new RegExp(`^${keyword}[\\s.)-]*$`).test(text);
  return text === keyword || new RegExp(`(^|[^\\p{L}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => fold(item)).filter(Boolean);
  return String(value || '').split(/[,\n]/).map((item) => fold(item)).filter(Boolean);
}

function renderText(value, contact) {
  const fullName = contact?.name?.trim() || 'cliente';
  const firstName = fullName.split(/\s+/)[0] || 'cliente';
  return String(value || '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, firstName)
    .replace(/\{\{\s*nombre_completo\s*\}\}/gi, fullName)
    .replace(/\{\{\s*telefono\s*\}\}/gi, contact?.phone || '');
}

// Bloque "Menú de opciones": cada opción tiene un número (key), un nombre, palabras extra y a dónde deriva.
function menuOptions(data) {
  return (Array.isArray(data.options) ? data.options : [])
    .filter((option) => option && String(option.key || option.label || '').trim())
    .slice(0, 20);
}

function optionWords(option) {
  const key = fold(option.key);
  const words = [key, fold(option.label), ...normalizeKeywords(option.keywords)];
  if (/^\d+$/.test(key)) words.push(`opcion ${key}`, `opcion nro ${key}`, `opcion numero ${key}`);
  return [...new Set(words.filter(Boolean))];
}

function menuText(data, contact, intro) {
  const lines = menuOptions(data).map((option) => `${String(option.key || '').trim() ? `${String(option.key).trim()}. ` : ''}${String(option.label || '').trim()}`);
  return [renderText(intro, contact).trim(), ...lines].filter(Boolean).join('\n');
}

// Saludos típicos: quien saluda está empezando la conversación, no contestando mal el menú.
const GREETING = /^(hola+|ola+|buenas?|buen dia|buenos dias|buenas tardes|buenas noches|hi|hey|hello|holis|saludos|que tal|como estas|buen día)[\s!¡.,]*$/;
function isGreeting(text) {
  return GREETING.test(fold(text));
}

// Etiqueta que deja el bloque "Agente humano": desde ahí el bot deja de contestar y el chat es de las personas.
const HANDOFF_TAG = 'Derivado';

// lastBotReply: lo último que el bot le escribió a esta persona (si fue hace poco). Sirve para saber si el cliente
// está respondiendo al menú o si recién empieza: solo se le dice "No entendí" a quien acaba de ver las opciones.
function runBotFlow(flowInput, { content = '', contact = null, conversation = null, isNewConversation = false, lastBotReply = '' } = {}) {
  const flow = normalizeFlow(flowInput);
  if (!flow.enabled || !flow.published) return null;
  // Un agente humano siempre tiene prioridad: si ya tomó el chat o el bot ya lo derivó, el flujo no vuelve a hablar.
  if (conversation && (conversation.assignedToId || (Array.isArray(conversation.tags) && conversation.tags.includes(HANDOFF_TAG)))) return null;

  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const start = flow.nodes.find((node) => node.type === 'start');
  if (!start) return null;

  const result = { handled: false, replies: [], useAi: false, aiPrompt: '', conversation: {}, visited: [] };
  let currentId = start.id;
  let steps = 0;
  while (currentId && steps < 24) {
    const node = nodes.get(currentId);
    if (!node) break;
    result.visited.push(node.id);
    steps += 1;
    const data = node.data || {};

    if (node.type === 'message') {
      if (!data.onlyOnNew || isNewConversation) {
        const text = renderText(data.text, contact).trim();
        if (text) result.replies.push(text);
        result.handled = result.handled || Boolean(text);
      }
    } else if (node.type === 'keyword') {
      const normalized = fold(content);
      const matched = normalizeKeywords(data.keywords).some((keyword) => keywordMatches(normalized, keyword));
      if (matched && data.response) {
        result.replies.push(renderText(data.response, contact).trim());
        result.handled = true;
      }
      currentId = getNextNodeId(flow.edges, node.id, matched ? (data.matchLabel || 'Coincide') : (data.fallbackLabel || 'No coincide'));
      continue;
    } else if (node.type === 'menu') {
      const normalized = fold(content);
      const chosen = menuOptions(data).find((option) => optionWords(option).some((word) => keywordMatches(normalized, word)));
      if (chosen) {
        if (chosen.departmentId) result.conversation.departmentId = String(chosen.departmentId);
        if (chosen.userId) result.conversation.assignedToId = String(chosen.userId);
        // Sin mensaje propio, el bot avisa igual que lo deriva: una opción solo necesita número, nombre y destino.
        const label = String(chosen.label || '').trim();
        const fallbackReply = label ? `Te paso con ${label}. En un momento te atienden.` : 'Te paso con una persona del equipo. En un momento te atienden.';
        const reply = renderText(chosen.message, contact).trim() || fallbackReply;
        if (reply) result.replies.push(reply);
        result.conversation.handoff = true;
        result.handled = true;
        result.useAi = false;
        break; // derivado: el bot no sigue
      }
      const fallback = flow.edges.find((edge) => edge.from === node.id && String(edge.label || '').toLowerCase() === String(data.fallbackLabel || 'No coincide').toLowerCase());
      if (!isNewConversation && fallback) { currentId = fallback.to; continue; } // sigue por "No coincide" (p. ej. a la IA)
      // ¿El menú fue lo último que le mandó el bot? Solo en ese caso el cliente está "contestando mal" el menú.
      const optionLines = menuOptions(data).map((option) => `${String(option.key || '').trim() ? `${String(option.key).trim()}. ` : ''}${String(option.label || '').trim()}`.trim()).filter(Boolean);
      // "No entendí" solo si el cliente intentó contestar el menú recién mostrado. A un saludo se le responde saludando.
      const justOfferedMenu = Boolean(lastBotReply) && optionLines.length > 0 && optionLines.every((line) => String(lastBotReply).includes(line));
      const intro = !isNewConversation && justOfferedMenu && !isGreeting(content)
        ? (data.invalidText || 'No entendí tu respuesta. Elegí una opción:')
        : (data.text || '¿Con qué área querés hablar?');
      const prompt = menuText(data, contact, intro);
      if (prompt) { result.replies.push(prompt); result.handled = true; }
      break;
    } else if (node.type === 'condition') {
      const condition = String(data.condition || 'always');
      const yes = condition === 'new_contact' ? isNewConversation : condition === 'has_name' ? Boolean(contact?.name) : condition === 'contains_text' ? String(content).trim().length > 0 : true;
      currentId = getNextNodeId(flow.edges, node.id, yes ? 'Sí' : 'No');
      continue;
    } else if (node.type === 'crm') {
      if (data.stage && CRM_STAGE_TAGS[data.stage]) result.conversation.crmStage = data.stage;
      const customTags = Array.isArray(data.tags) ? data.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 20) : normalizeKeywords(data.tags);
      if (customTags.length) result.conversation.tags = customTags;
      result.handled = true;
    } else if (node.type === 'agent') {
      if (data.departmentId) result.conversation.departmentId = String(data.departmentId);
      if (data.userId) result.conversation.assignedToId = String(data.userId);
      const handoffText = renderText(data.message, contact).trim();
      if (handoffText) result.replies.push(handoffText);
      result.conversation.handoff = true;
      result.handled = true;
      result.useAi = false;
      break; // derivado: el bot no sigue
    } else if (node.type === 'ai') {
      result.useAi = true;
      result.aiPrompt = String(data.prompt || '').trim();
      result.handled = true;
    } else if (node.type === 'end') {
      break;
    }

    currentId = getNextNodeId(flow.edges, node.id);
  }

  return result.handled || result.useAi ? result : null;
}

function conversationUpdateData(conversation, result) {
  if (!result?.conversation) return {};
  const data = {};
  const actions = result.conversation;
  if (actions.departmentId) data.departmentId = actions.departmentId;
  if (actions.assignedToId) data.assignedToId = actions.assignedToId;
  if (actions.crmStage && CRM_STAGE_TAGS[actions.crmStage]) {
    const stageTag = CRM_STAGE_TAGS[actions.crmStage];
    const currentTags = Array.isArray(conversation.tags) ? conversation.tags : [];
    data.tags = [...currentTags.filter((tag) => !Object.values(CRM_STAGE_TAGS).includes(tag) && tag !== 'Bot'), stageTag, 'Bot'];
    if (['abiertas', 'pendientes', 'cerradas'].includes(actions.crmStage)) data.status = actions.crmStage === 'abiertas' ? 'OPEN' : actions.crmStage === 'pendientes' ? 'PENDING' : 'CLOSED';
  }
  if (actions.handoff) {
    const currentTags = Array.isArray(data.tags) ? data.tags : (Array.isArray(conversation.tags) ? conversation.tags : []);
    data.tags = [...new Set([...currentTags, HANDOFF_TAG])].slice(0, 30);
    data.status = 'OPEN';
  }
  if (Array.isArray(actions.tags)) {
    const currentTags = Array.isArray(data.tags) ? data.tags : (Array.isArray(conversation.tags) ? conversation.tags : []);
    data.tags = [...new Set([...currentTags, ...actions.tags])].slice(0, 30);
  }
  return data;
}

module.exports = { HANDOFF_TAG, defaultBotFlow, normalizeFlow, runBotFlow, conversationUpdateData };
