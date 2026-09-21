// Quién puede ver una conversación. Una sola fuente de verdad para las consultas (HTTP), el tiempo real y las
// notificaciones, así lo que ve un agente en la lista y lo que le llega en vivo coinciden siempre.
//
// Propietario, administrador y supervisor ven todo. Un AGENTE ve:
//   · lo que tiene asignado a él;
//   · lo que no tiene asignado y fue enviado a un área de la que es miembro;
//   · los chats nuevos sin asignar y sin área, SOLO si tiene activado el "auto chat".
// Sin auto chat, esos chats nuevos le llegan cuando un administrador se los transfiere.
const { prisma } = require('./prisma');

async function agentAccess(organizationId, userId) {
  const [memberships, user] = await Promise.all([
    prisma.departmentMember.findMany({ where: { userId, department: { organizationId } }, select: { departmentId: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { autoChat: true } })
  ]);
  return { userId, deptIds: memberships.map((m) => m.departmentId), autoChat: Boolean(user?.autoChat) };
}

// Filtro de Prisma equivalente a canAgentSee, para listar y cargar conversaciones.
function agentVisibilityWhere(access) {
  return {
    OR: [
      { assignedToId: access.userId },
      { assignedToId: null, OR: [...(access.autoChat ? [{ departmentId: null }] : []), { departmentId: { in: access.deptIds } }] }
    ]
  };
}

// Condición para tomar (claim) una conversación sin asignar.
function agentClaimWhere(access) {
  return [...(access.autoChat ? [{ departmentId: null }] : []), { departmentId: { in: access.deptIds } }];
}

function canAgentSee(access, conversation) {
  if (conversation.assignedToId) return conversation.assignedToId === access.userId;
  if (conversation.departmentId) return access.deptIds.includes(conversation.departmentId);
  return access.autoChat;
}

// Agentes activos de la organización con lo necesario para decidir la visibilidad (con caché corto:
// se consulta en cada mensaje). Cambiar auto chat o áreas invalida el caché.
const CACHE_MS = 5000;
const agentCache = new Map();

function invalidateAgentCache(organizationId) {
  if (organizationId) agentCache.delete(organizationId); else agentCache.clear();
}

async function orgAgents(organizationId) {
  const hit = agentCache.get(organizationId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.agents;
  const rows = await prisma.user.findMany({
    where: { organizationId, role: 'AGENT', active: true },
    select: { id: true, autoChat: true, memberships: { select: { departmentId: true } } }
  });
  const agents = rows.map((row) => ({ userId: row.id, autoChat: row.autoChat, deptIds: row.memberships.map((m) => m.departmentId) }));
  agentCache.set(organizationId, { at: Date.now(), agents });
  return agents;
}

// { seeing: [ids de agentes que la ven], hidden: [ids de agentes que no] } para una conversación.
async function agentAudience(organizationId, conversation) {
  const agents = await orgAgents(organizationId);
  const seeing = [];
  const hidden = [];
  for (const agent of agents) (canAgentSee(agent, conversation) ? seeing : hidden).push(agent.userId);
  return { seeing, hidden };
}

module.exports = { agentAccess, agentVisibilityWhere, agentClaimWhere, canAgentSee, agentAudience, invalidateAgentCache };
