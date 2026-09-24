// Avisos de los paneles de Facebook/Instagram → campana de Niro. Hay un panel por organización
// (supervisor.mjs del paquete): cada 30 s se pregunta cuáles están levantados y se mantiene una conexión
// SSE (/api/stream, header X-Niro-Org) con cada uno. Cada aviso nuevo va por socket
// ("facebook:notification") solo a la administración de ESA organización.
const panel = require('./facebookPanel');
const { emitToOrgStaff } = require('./realtime');

const BURST_WINDOW_MS = 4000;
const BURST_LIMIT = 4; // más avisos que esto juntos (ej. primera sincronización) → uno solo de resumen
const DISCOVER_MS = 30000;
const KIND_LABEL = {
  message: 'Mensaje de Messenger', comment: 'Comentario en Facebook', reaction: 'Reacción en Facebook',
  mention: 'Mención en Facebook', marketplace: 'Marketplace', security: 'Aviso de seguridad de Facebook'
};

let started = false;
const streams = new Map(); // orgId → { buffer, flushTimer }

function toNotification(event) {
  const text = String(event.text || '').replace(/\s+/g, ' ').trim();
  return {
    id: event.id,
    kind: event.kind || 'other',
    title: KIND_LABEL[event.kind] || 'Aviso de Facebook',
    body: text.length > 140 ? `${text.slice(0, 140)}…` : text || 'Nuevo aviso',
    section: event.kind === 'message' ? 'messenger' : 'notificaciones'
  };
}

function flush(orgId, state) {
  state.flushTimer = null;
  const events = state.buffer;
  state.buffer = [];
  if (!events.length) return;
  const notifications = events.length > BURST_LIMIT
    ? [{ id: `fb-summary-${Date.now()}`, kind: 'summary', title: 'Facebook / Instagram', body: `${events.length} avisos nuevos de Facebook`, section: 'notificaciones' }]
    : events.map(toNotification);
  for (const n of notifications) emitToOrgStaff(orgId, 'facebook:notification', n);
}

function onFrame(orgId, state, type, data) {
  if (type !== 'event') return;
  let payload;
  try { payload = JSON.parse(data); } catch { return; }
  if (!payload?.event?.id) return;
  state.buffer.push(payload.event);
  if (!state.flushTimer) state.flushTimer = setTimeout(() => flush(orgId, state), BURST_WINDOW_MS);
}

async function follow(orgId, state) {
  const cookie = (await panel.loginCookie(orgId)).split(';')[0];
  const response = await fetch(`${panel.panelUrl()}/api/stream`, { headers: panel.orgHeaders(orgId, { cookie, accept: 'text/event-stream' }) });
  if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
  console.log(`[facebook-bridge] ${orgId}: conectado al stream del panel`);
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      let type = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onFrame(orgId, state, type, data.join('\n'));
    }
  }
  throw new Error('el stream se cerró');
}

function watch(orgId) {
  if (streams.has(orgId)) return;
  const state = { buffer: [], flushTimer: null };
  streams.set(orgId, state);
  follow(orgId, state)
    .catch((err) => console.warn(`[facebook-bridge] ${orgId}: ${err.message}`))
    .finally(() => streams.delete(orgId)); // el próximo descubrimiento vuelve a conectar si sigue levantado
}

async function discover() {
  try {
    for (const orgId of await panel.runningOrgs()) watch(orgId);
  } catch (err) {
    console.warn(`[facebook-bridge] no se pudo consultar los paneles: ${err.message}`);
  }
}

function start() {
  if (started || !panel.isConfigured()) return;
  started = true;
  setTimeout(discover, 3000);
  setInterval(discover, DISCOVER_MS).unref();
}

module.exports = { start, toNotification };
