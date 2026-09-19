// Notificaciones push al equipo (Web Push / VAPID). Sin claves configuradas, todo esto queda
// apagado — nada se rompe, simplemente no se manda nada (igual que niroAi.js con su API key).
const webpush = require('web-push');
const { prisma } = require('./prisma');
const { isUserOnline } = require('./realtime');

// Leídas en cada llamada (no una vez al cargar el módulo) para que un cambio de las variables de
// entorno —o un test que las simula— no necesite reiniciar el proceso ni resetear el caché de
// módulos de Node.
let vapidAppliedTo = null; // evita llamar setVapidDetails de nuevo si las claves no cambiaron

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function vapidPublicKey() {
  return isConfigured() ? process.env.VAPID_PUBLIC_KEY : null;
}

function ensureVapidApplied() {
  if (!isConfigured()) return false;
  const key = process.env.VAPID_PUBLIC_KEY + '|' + process.env.VAPID_PRIVATE_KEY;
  if (vapidAppliedTo === key) return true;
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:soporte@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    vapidAppliedTo = key;
    return true;
  } catch (err) {
    console.error('[push] no se pudieron cargar las claves VAPID:', err.message || err);
    return false;
  }
}

async function saveSubscription(userId, subscription, userAgent) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    const err = new Error('Suscripción push inválida');
    err.status = 400;
    throw err;
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || null },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || null }
  });
}

async function removeSubscription(userId, endpoint) {
  if (!endpoint) return;
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
}

// Manda a todas las suscripciones de un usuario. Una suscripción vencida/revocada (404/410 del
// navegador/servicio push) se borra sola; cualquier otro error queda logueado pero nunca corta
// el flujo que llamó a esto — mandar una notificación jamás debe romper un mensaje real.
async function sendToUser(userId, payload) {
  if (!isConfigured() || !userId) return;
  if (!ensureVapidApplied()) return;
  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body
        );
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          console.error('[push] envío falló para', sub.id, err.message || err);
        }
      }
    })
  );
}

async function sendToUsers(userIds, payload) {
  await Promise.all([...new Set(userIds.filter(Boolean))].map((userId) => sendToUser(userId, payload)));
}

// Alerta a los que gestionan la bandeja de una organización (dueño/admin/supervisor) — se usa
// cuando llega una conversación sin agente asignado, para que alguien la tome.
async function sendToOrgManagers(organizationId, payload, { skipOnline = true } = {}) {
  if (!isConfigured() || !organizationId) return;
  const managers = await prisma.user.findMany({
    where: { organizationId, active: true, role: { in: ['OWNER', 'ADMIN', 'SUPERVISOR'] } },
    select: { id: true }
  });
  const targets = managers.map((m) => m.id).filter((id) => !skipOnline || !isUserOnline(organizationId, id));
  await sendToUsers(targets, payload);
}

// Notifica a un agente puntual, salvo que ya tenga la app abierta (tiene un socket conectado) —
// para eso ya recibe el mensaje en tiempo real, no hace falta duplicar con una notificación.
async function sendToAgent(organizationId, userId, payload, { skipOnline = true } = {}) {
  if (!isConfigured() || !userId) return;
  if (skipOnline && isUserOnline(organizationId, userId)) return;
  await sendToUser(userId, payload);
}

// Punto único de decisión para "¿a quién le aviso que llegó un mensaje nuevo?": si la
// conversación ya tiene agente asignado, solo a esa persona; si no, a quienes gestionan la
// bandeja (para que alguien la tome). Nunca lanza — un fallo acá no debe tumbar el mensaje real.
async function notifyNewInboundMessage({ organizationId, conversation, contactLabel, preview, channel }) {
  if (!isConfigured() || !organizationId) return;
  try {
    const payload = {
      title: `${channel === 'whatsapp' ? '💬 WhatsApp' : '🌐 Web'} · ${contactLabel}`,
      body: preview ? preview.slice(0, 160) : 'Nuevo mensaje',
      url: `/inbox?conversation=${conversation.id}`,
      tag: `conversation-${conversation.id}`
    };
    if (conversation.assignedToId) {
      await sendToAgent(organizationId, conversation.assignedToId, payload);
    } else {
      await sendToOrgManagers(organizationId, payload);
    }
  } catch (err) {
    console.error('[push] notifyNewInboundMessage falló:', err.message || err);
  }
}

module.exports = {
  isConfigured,
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  sendToUser,
  sendToUsers,
  sendToOrgManagers,
  sendToAgent,
  notifyNewInboundMessage
};
