const cookie = require('cookie');
const { Server } = require('socket.io');
const { verifyToken, ACCESS_COOKIE } = require('./tokens');
const { prisma } = require('./prisma');

let io = null;

// Estados que una persona puede elegir. "offline" no se elige: lo deriva el servidor cuando no queda ninguna pestaña conectada.
const PRESENCE_STATUSES = ['available', 'busy', 'pending', 'break', 'rest', 'away'];

// Track presence: orgId -> Map<userId, { socketIds: Set<string>, status: string, user: { id, name, role, email }, lastSeen: Date }>
const orgPresence = new Map();

function getOrgPresenceMap(orgId) {
  if (!orgPresence.has(orgId)) {
    orgPresence.set(orgId, new Map());
  }
  return orgPresence.get(orgId);
}

function getOrgPresenceList(orgId) {
  const map = getOrgPresenceMap(orgId);
  const list = [];
  for (const [userId, data] of map.entries()) {
    if (data.socketIds.size > 0) {
      list.push({
        userId,
        name: data.user?.name || 'Agente',
        email: data.user?.email || '',
        role: data.user?.role || 'AGENT',
        status: data.status || 'available', // 'available' | 'busy' | 'away' | 'offline'
        online: true,
        lastSeen: data.lastSeen
      });
    }
  }
  return list;
}

function broadcastPresence(orgId) {
  if (!io || !orgId) return;
  const list = getOrgPresenceList(orgId);
  io.to(`org:${orgId}`).emit('agent:presence_list', { presence: list });
}

function attachSocketServer(httpServer) {
  io = new Server(httpServer, { cors: { origin: true, credentials: true } });

  io.use(async (socket, next) => {
    try {
      const widgetToken = socket.handshake.auth?.widgetToken;
      if (widgetToken) {
        const conversation = await prisma.conversation.findUnique({
          where: { widgetToken },
          select: { id: true }
        });
        if (!conversation) return next(new Error('unauthorized'));
        socket.data.widget = { conversationId: conversation.id };
        return next();
      }

      const origin = socket.handshake.headers.origin;
      if (origin && !(process.env.WEB_ORIGIN || 'http://localhost:3000').split(',').map(x => x.trim()).includes(origin)) return next(new Error('unauthorized origin'));
      const cookies = cookie.parse(socket.handshake.headers.cookie || '');
      const token = cookies[ACCESS_COOKIE];
      if (!token) return next(new Error('unauthorized'));

      const payload = verifyToken(token);
      if (payload.type !== 'access') return next(new Error('unauthorized'));

      const dbUser = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, name: true, email: true, role: true, active: true, organizationId: true, organization: { select: { active: true } } }
      });
      if (!dbUser?.active || (dbUser.organizationId && !dbUser.organization?.active)
        || dbUser.organizationId !== (payload.organizationId ?? null)) return next(new Error('unauthorized'));
      socket.data.auth = {
        userId: dbUser.id, organizationId: dbUser.organizationId, role: dbUser.role,
        user: { id: dbUser.id, name: dbUser.name, email: dbUser.email, role: dbUser.role }
      };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.widget) {
      socket.join(`conversation:${socket.data.widget.conversationId}`);
      return;
    }

    require('./callMedia').attachCallMedia(socket);
    const { organizationId, userId, user } = socket.data.auth || {};
    if (organizationId) {
      socket.join(`org:${organizationId}`);
      if (socket.data.auth?.role !== 'AGENT') socket.join(`org:${organizationId}:staff`);
      if (userId) {
        socket.join(`user:${userId}`);

        // Al conectarse la persona queda "en línea" con el último estado que eligió (o Disponible).
        registerPresence(organizationId, userId, user, socket.id);

        // Send current presence list to newly connected socket
        socket.emit('agent:presence_list', { presence: getOrgPresenceList(organizationId) });
        // Broadcast presence change to entire org
        broadcastPresence(organizationId);

        // Handle agent status update from client
        socket.on('agent:set_status', (data) => {
          if (PRESENCE_STATUSES.includes(data?.status)) setAgentPresenceStatus(organizationId, userId, data.status);
        });

        socket.on('disconnect', () => {
          releasePresence(organizationId, userId, socket.id);
          broadcastPresence(organizationId);
        });
      }
    }
  });

  return io;
}

// Eventos que llevan datos de una conversación. No van a toda la organización: los agentes solo reciben los de
// conversaciones que pueden ver (ver lib/chatAccess.js). Sin esto, quien no tiene "auto chat" recibiría igual
// los chats nuevos y sus mensajes en tiempo real aunque la lista de la API se los oculte.
const CONVERSATION_EVENTS = new Set(['conversation:new', 'conversation:updated', 'message:new', 'message:updated', 'message:deleted']);
// Las emisiones de una misma organización salen en orden (conversation:new antes que sus message:new).
const orgQueues = new Map();

async function emitConversationScoped(organizationId, event, payload) {
  const conversationId = payload?.conversation?.id || payload?.conversationId;
  const conversation = conversationId
    ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedToId: true, departmentId: true } })
    : null;
  // Propietario, administrador y supervisor: siempre.
  io.to(`org:${organizationId}:staff`).emit(event, payload);
  if (!conversation) return;
  const { seeing, hidden } = await require('./chatAccess').agentAudience(organizationId, conversation);
  for (const userId of seeing) io.to(`user:${userId}`).emit(event, payload);
  // Si una conversación deja de ser visible para alguien (p. ej. se la transfirieron a otro), que la saque de su lista.
  if (event === 'conversation:updated') for (const userId of hidden) io.to(`user:${userId}`).emit('conversation:hidden', { conversationId });
}

function emitToOrg(organizationId, event, payload) {
  if (!io || !organizationId) return;
  if (!CONVERSATION_EVENTS.has(event)) { io.to(`org:${organizationId}`).emit(event, payload); return; }
  const previous = orgQueues.get(organizationId) || Promise.resolve();
  const next = previous.then(() => emitConversationScoped(organizationId, event, payload)).catch((err) => console.error('[realtime] emisión filtrada falló:', err.message || err));
  orgQueues.set(organizationId, next);
  next.finally(() => { if (orgQueues.get(organizationId) === next) orgQueues.delete(organizationId); });
}

function emitToConversation(conversationId, event, payload) {
  if (!io || !conversationId) return;
  io.to(`conversation:${conversationId}`).emit(event, payload);
}

function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(event, payload);
}

// True si ese usuario tiene al menos una pestaña con socket abierto ahora mismo — se usa para no
// mandarle una notificación push cuando ya está viendo la app en tiempo real.
function isUserOnline(organizationId, userId) {
  const orgMap = orgPresence.get(organizationId);
  const entry = orgMap && orgMap.get(userId);
  return !!(entry && entry.socketIds.size > 0);
}

// Una pestaña (socket) se conecta: si la persona estaba "offline" vuelve a su último estado elegido, no queda desconectada.
function registerPresence(organizationId, userId, user, socketId) {
  const orgMap = getOrgPresenceMap(organizationId);
  const entry = orgMap.get(userId) || { socketIds: new Set(), status: 'available', preferred: 'available', user, lastSeen: new Date() };
  entry.socketIds.add(socketId);
  entry.user = user;
  entry.lastSeen = new Date();
  if (entry.status === 'offline' || entry.socketIds.size === 1) entry.status = entry.preferred || 'available';
  orgMap.set(userId, entry);
  return entry;
}

// Una pestaña se desconecta: recién cuando no queda ninguna la persona pasa a "offline" (recordando su estado elegido).
function releasePresence(organizationId, userId, socketId) {
  const entry = getOrgPresenceMap(organizationId).get(userId);
  if (!entry) return;
  entry.socketIds.delete(socketId);
  entry.lastSeen = new Date();
  if (entry.socketIds.size === 0) entry.status = 'offline';
}

function setAgentPresenceStatus(organizationId, userId, status) {
  if (!PRESENCE_STATUSES.includes(status)) return false;
  const entry = getOrgPresenceMap(organizationId).get(userId);
  if (!entry || entry.socketIds.size === 0) return false;
  entry.status = status;
  entry.preferred = status;
  entry.lastSeen = new Date();
  broadcastPresence(organizationId);
  return true;
}

module.exports = {
  attachSocketServer,
  emitToOrg,
  emitToConversation,
  emitToUser,
  getOrgPresenceList,
  isUserOnline,
  setAgentPresenceStatus,
  registerPresence,
  releasePresence,
  PRESENCE_STATUSES,
  broadcastPresence
};
