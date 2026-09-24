// Webhooks de la API pública: cuando entra un mensaje, cambia su estado o se actualiza un chat, se avisa por HTTP
// a las URLs que registró la empresa. Cada envío va firmado para que el receptor pueda comprobar que es de Niro.
const crypto = require('crypto');
const { prisma } = require('./prisma');

const EVENTS = ['message.received', 'message.status', 'conversation.updated', 'status.published'];
const TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [2000, 10000]; // dos reintentos y listo: el resto se consulta por API

function newSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

function sign(secret, body, timestamp) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function sanitizeWebhook(hook, { includeSecret = false } = {}) {
  return {
    id: hook.id,
    url: hook.url,
    events: hook.events,
    active: hook.active,
    lastStatus: hook.lastStatus,
    lastError: hook.lastError,
    lastDeliveryAt: hook.lastDeliveryAt,
    createdAt: hook.createdAt,
    ...(includeSecret ? { secret: hook.secret } : {})
  };
}

async function post(hook, payload, attempt = 0) {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'NiroBot-Webhook/1',
        'X-Niro-Event': payload.event,
        'X-Niro-Timestamp': timestamp,
        'X-Niro-Signature': `sha256=${sign(hook.secret, body, timestamp)}`
      },
      body
    });
    await prisma.apiWebhook.update({
      where: { id: hook.id },
      data: { lastStatus: response.status, lastError: response.ok ? null : `HTTP ${response.status}`, lastDeliveryAt: new Date() }
    }).catch(() => {});
    if (!response.ok && attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => post(hook, payload, attempt + 1).catch(() => {}), RETRY_DELAYS_MS[attempt]);
    }
  } catch (err) {
    await prisma.apiWebhook.update({
      where: { id: hook.id },
      data: { lastStatus: null, lastError: String(err.message || err).slice(0, 300), lastDeliveryAt: new Date() }
    }).catch(() => {});
    if (attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => post(hook, payload, attempt + 1).catch(() => {}), RETRY_DELAYS_MS[attempt]);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Avisa a los webhooks activos suscriptos a ese evento. No corta el flujo si fallan: se reintenta aparte. */
async function emitWebhook(organizationId, event, data) {
  if (!organizationId || !EVENTS.includes(event)) return;
  const hooks = await prisma.apiWebhook.findMany({ where: { organizationId, active: true, events: { has: event } } }).catch(() => []);
  if (hooks.length === 0) return;
  const payload = { event, sentAt: new Date().toISOString(), organizationId, data };
  for (const hook of hooks) post(hook, payload).catch(() => {});
}

module.exports = { EVENTS, emitWebhook, newSecret, sign, sanitizeWebhook };
