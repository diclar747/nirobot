// WhatsApp "estados" (stories): the 24-hour photos, videos and text updates that contacts
// publish. They reach the linked device as messages addressed to status@broadcast, which the
// regular inbound pipeline deliberately ignores (they are not conversations). Here they are
// stored on their own, shown as stories in the inbox and deleted when they expire.
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');
const { saveFile, deleteFile } = require('./storage');
const { extensionFor } = require('./attachments');

const STATUS_BROADCAST = 'status@broadcast';
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const STORY_MEDIA_KINDS = new Set(['image', 'video']);
const REVOKE = 0; // proto.Message.ProtocolMessage.Type.REVOKE

function toSeconds(timestamp) {
  if (timestamp && typeof timestamp === 'object' && 'low' in timestamp) {
    return (timestamp.high || 0) * 4294967296 + (timestamp.low >>> 0);
  }
  return Number(timestamp || 0);
}

// WhatsApp stores the text-status background as a signed 32-bit ARGB integer.
function argbToHex(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `#${((n >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

function isStatusBroadcast(jid) {
  return jid === STATUS_BROADCAST;
}

function sanitizeStatus(status, contact) {
  const person = contact || status.contact || null;
  return {
    id: status.id,
    contactId: status.contactId || null,
    key: status.contactId || status.participantJid,
    name: (person && person.name) || status.displayName || status.phone || 'Contacto',
    phone: status.phone || (person && person.phone) || null,
    avatarUrl: (person && person.avatarUrl) || null,
    kind: status.kind,
    text: status.text || null,
    caption: status.caption || null,
    backgroundColor: status.backgroundColor || null,
    mimeType: status.mimeType || null,
    mediaUrl: status.storageKey ? `/api/org/statuses/${status.id}/media` : null,
    fromMe: Boolean(status.fromMe),
    postedAt: status.postedAt,
    expiresAt: status.expiresAt
  };
}

// helpers are injected by whatsapp.js (this module cannot require it back without a cycle).
async function handleStatusMessage(organizationId, sock, waMessage, helpers) {
  const key = waMessage && waMessage.key;
  if (!key || !isStatusBroadcast(key.remoteJid) || !waMessage.message) return false;

  const protocol = waMessage.message.protocolMessage;
  if (protocol && protocol.key && protocol.type === REVOKE) {
    const removed = await prisma.whatsappStatus.findFirst({ where: { organizationId, waMessageId: protocol.key.id } });
    if (removed) {
      await prisma.whatsappStatus.delete({ where: { id: removed.id } });
      if (removed.storageKey) await deleteFile(removed.storageKey);
      emitToOrg(organizationId, 'status:deleted', { id: removed.id });
    }
    return true;
  }

  const fromMe = Boolean(key.fromMe);
  const rawJid = fromMe ? (sock && sock.user && sock.user.id) : (key.participant || waMessage.participant);
  if (!rawJid || !key.id) return true;

  const seconds = toSeconds(waMessage.messageTimestamp);
  const postedAt = seconds > 0 ? new Date(seconds * 1000) : new Date();
  const expiresAt = new Date(postedAt.getTime() + STATUS_TTL_MS);
  if (expiresAt.getTime() <= Date.now()) return true;

  if (await prisma.whatsappStatus.findUnique({ where: { organizationId_waMessageId: { organizationId, waMessageId: key.id } }, select: { id: true } })) return true;

  const media = helpers.extractMedia(waMessage);
  const caption = helpers.extractText(waMessage);
  const data = { organizationId, participantJid: rawJid, waMessageId: key.id, fromMe, postedAt, expiresAt };

  if (media && STORY_MEDIA_KINDS.has(media.kind)) {
    const buffer = await helpers.downloadInboundMedia(sock, waMessage, media);
    if (!buffer) return true;
    data.kind = media.kind;
    data.mimeType = media.mimeType;
    data.storageKey = await saveFile(organizationId, buffer, extensionFor(media.mimeType));
    data.caption = caption ? String(caption).slice(0, 1000) : null;
  } else {
    if (media || !caption) return true;
    data.kind = 'text';
    data.text = String(caption).slice(0, 2000);
    data.backgroundColor = argbToHex(waMessage.message.extendedTextMessage && waMessage.message.extendedTextMessage.backgroundArgb);
  }

  const resolvedJid = await helpers.resolvePhoneJid(sock, key.participantAlt || rawJid);
  const phone = helpers.phoneFromJid(resolvedJid);
  const contact = fromMe
    ? null
    : await prisma.contact.findFirst({
        where: { organizationId, OR: [...(phone ? [{ phone }] : []), { externalId: rawJid }] },
        select: { id: true, name: true, phone: true, avatarUrl: true }
      });
  data.phone = phone || null;
  data.contactId = contact ? contact.id : null;
  data.displayName = fromMe ? 'Mi estado' : (waMessage.pushName || (contact && contact.name) || null);

  let created;
  try {
    created = await prisma.whatsappStatus.create({ data });
  } catch (err) {
    // A replayed upsert can race the duplicate check above; the unique index makes it harmless.
    if (err && err.code === 'P2002') {
      if (data.storageKey) await deleteFile(data.storageKey);
      return true;
    }
    throw err;
  }
  emitToOrg(organizationId, 'status:new', { status: sanitizeStatus(created, contact) });
  return true;
}

// Active statuses grouped per contact, newest activity first (own status always first).
async function listActive(organizationId) {
  const rows = await prisma.whatsappStatus.findMany({
    where: { organizationId, expiresAt: { gt: new Date() } },
    orderBy: { postedAt: 'asc' },
    include: { contact: { select: { id: true, name: true, phone: true, avatarUrl: true } } }
  });
  const groups = new Map();
  for (const row of rows) {
    const item = sanitizeStatus(row);
    let group = groups.get(item.key);
    if (!group) {
      group = { key: item.key, contactId: item.contactId, name: item.name, phone: item.phone, avatarUrl: item.avatarUrl, fromMe: item.fromMe, latestAt: item.postedAt, items: [] };
      groups.set(item.key, group);
    }
    group.items.push(item);
    group.latestAt = item.postedAt;
  }
  return [...groups.values()].sort((a, b) => (Number(b.fromMe) - Number(a.fromMe)) || (new Date(b.latestAt) - new Date(a.latestAt)));
}

async function cleanupExpired() {
  const expired = await prisma.whatsappStatus.findMany({ where: { expiresAt: { lte: new Date() } }, select: { id: true, storageKey: true } });
  for (const row of expired) if (row.storageKey) await deleteFile(row.storageKey);
  if (expired.length) await prisma.whatsappStatus.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } });
  return expired.length;
}

module.exports = { STATUS_BROADCAST, isStatusBroadcast, handleStatusMessage, listActive, cleanupExpired, sanitizeStatus, argbToHex };
