const cookie = require('cookie');
const { Server } = require('socket.io');
const { verifyToken, ACCESS_COOKIE } = require('./tokens');
const { prisma } = require('./prisma');

let io = null;

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

      const cookies = cookie.parse(socket.handshake.headers.cookie || '');
      const token = cookies[ACCESS_COOKIE];
      if (!token) return next(new Error('unauthorized'));

      const payload = verifyToken(token);
      if (payload.type !== 'access') return next(new Error('unauthorized'));

      // Fetch user name & role
      let userObj = { id: payload.sub, name: 'Usuario', email: '', role: payload.role };
      try {
        const dbUser = await prisma.user.findUnique({
          where: { id: payload.sub },
          select: { id: true, name: true, email: true, role: true }
        });
        if (dbUser) userObj = dbUser;
      } catch (e) {
        // fallback
      }

      socket.data.auth = {
        userId: payload.sub,
        organizationId: payload.organizationId ?? null,
        role: payload.role,
        user: userObj
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

    const { organizationId, userId, user } = socket.data.auth || {};
    if (organizationId) {
      socket.join(`org:${organizationId}`);
      if (userId) {
        socket.join(`user:${userId}`);

        // Register in presence map
        const orgMap = getOrgPresenceMap(organizationId);
        const existing = orgMap.get(userId) || {
          socketIds: new Set(),
          status: 'available',
          user,
          lastSeen: new Date()
        };
        existing.socketIds.add(socket.id);
        existing.lastSeen = new Date();
        existing.user = user;
        orgMap.set(userId, existing);

        // Send current presence list to newly connected socket
        socket.emit('agent:presence_list', { presence: getOrgPresenceList(organizationId) });
        // Broadcast presence change to entire org
        broadcastPresence(organizationId);

        // Handle agent status update from client
        socket.on('agent:set_status', (data) => {
          const status = ['available', 'busy', 'away', 'offline'].includes(data?.status)
            ? data.status
            : 'available';
          const entry = orgMap.get(userId);
          if (entry) {
            entry.status = status;
            entry.lastSeen = new Date();
            broadcastPresence(organizationId);
          }
        });

        socket.on('disconnect', () => {
          const entry = orgMap.get(userId);
          if (entry) {
            entry.socketIds.delete(socket.id);
            entry.lastSeen = new Date();
            if (entry.socketIds.size === 0) {
              entry.status = 'offline';
            }
            broadcastPresence(organizationId);
          }
        });
      }
    }
  });

  return io;
}

function emitToOrg(organizationId, event, payload) {
  if (!io || !organizationId) return;
  io.to(`org:${organizationId}`).emit(event, payload);
}

function emitToConversation(conversationId, event, payload) {
  if (!io || !conversationId) return;
  io.to(`conversation:${conversationId}`).emit(event, payload);
}

function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(event, payload);
}

function setAgentPresenceStatus(organizationId, userId, status) {
  const orgMap = getOrgPresenceMap(organizationId);
  const entry = orgMap.get(userId);
  if (entry) {
    entry.status = status;
    entry.lastSeen = new Date();
    broadcastPresence(organizationId);
  }
}

module.exports = {
  attachSocketServer,
  emitToOrg,
  emitToConversation,
  emitToUser,
  getOrgPresenceList,
  setAgentPresenceStatus,
  broadcastPresence
};
