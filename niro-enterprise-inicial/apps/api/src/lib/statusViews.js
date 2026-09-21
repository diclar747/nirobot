// Vistas y "me gusta" de los estados propios. WhatsApp los informa con dos eventos: un recibo de lectura por cada
// persona que abre el estado y un mensaje de reacción cuando alguien lo marca con un emoji.
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');

async function countsFor(organizationId, waMessageId) {
  const [views, reactions] = await Promise.all([
    prisma.whatsappStatusView.count({ where: { organizationId, waMessageId, viewedAt: { not: null } } }),
    prisma.whatsappStatusView.count({ where: { organizationId, waMessageId, reaction: { not: null } } })
  ]);
  return { views, reactions };
}

function sanitizeView(row) {
  return {
    id: row.id,
    viewerJid: row.viewerJid,
    phone: row.phone,
    name: row.displayName,
    viewedAt: row.viewedAt,
    reaction: row.reaction,
    reactedAt: row.reactedAt
  };
}

// Suma una vista y/o una reacción de `viewerJid` sobre el estado `waMessageId`. Una vista posterior nunca borra la
// reacción, y la primera hora de vista se conserva. `reaction: null` con `hasReaction` quita el "me gusta".
async function recordStatusActivity(organizationId, { waMessageId, viewerJid, phone = null, viewedAt = null, hasReaction = false, reaction = null, reactedAt = null }) {
  if (!organizationId || !waMessageId || !viewerJid) return null;
  const contact = phone ? await prisma.contact.findFirst({ where: { organizationId, phone }, select: { id: true, name: true } }) : null;
  const existing = await prisma.whatsappStatusView.findUnique({ where: { organizationId_waMessageId_viewerJid: { organizationId, waMessageId, viewerJid } } });
  const data = {
    phone: phone || existing?.phone || null,
    displayName: contact?.name || existing?.displayName || null,
    contactId: contact?.id || existing?.contactId || null,
    viewedAt: existing?.viewedAt || viewedAt || (hasReaction && reaction ? reactedAt || new Date() : null),
    ...(hasReaction ? { reaction: reaction || null, reactedAt: reaction ? reactedAt || new Date() : null } : {})
  };
  const row = existing
    ? await prisma.whatsappStatusView.update({ where: { id: existing.id }, data })
    : await prisma.whatsappStatusView.create({ data: { organizationId, waMessageId, viewerJid, ...data } });

  const post = await prisma.whatsappStatusPost.findFirst({ where: { organizationId, waMessageId }, select: { id: true } });
  emitToOrg(organizationId, 'status:view', { postId: post?.id || null, waMessageId, view: sanitizeView(row), counts: await countsFor(organizationId, waMessageId) });
  return row;
}

module.exports = { recordStatusActivity, countsFor, sanitizeView };
