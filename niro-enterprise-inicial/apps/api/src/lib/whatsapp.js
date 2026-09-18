const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidNewsletter,
  isJidBroadcast,
  isJidStatusBroadcast,
  isJidBot,
  isPnUser,
  isLidUser,
  isHostedPnUser,
  isHostedLidUser,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');
const { renderWelcome, matchMenuOption } = require('./bot');
const aiBot = require('./aiBot');
const { transcribeMessageAudio } = require('./aiMedia');
const { saveFile } = require('./storage');
const { isAllowedMimeType, extensionFor } = require('./attachments');
const { CONVERSATION_INCLUDE, MESSAGE_INCLUDE, sanitizeConversation, sanitizeMessage, broadcastMessage, sendBotMessage } = require('./conversations');

const SESSION_ROOT = process.env.WHATSAPP_SESSION_ROOT || path.join(__dirname, '..', '..', 'storage', 'whatsapp-sessions');

const sessions = new Map();

function sessionDir(organizationId) {
  return path.join(SESSION_ROOT, organizationId);
}

function publicStatus(organizationId) {
  const entry = sessions.get(organizationId);
  if (!entry) return { status: 'disconnected', qr: null, phone: null };
  return { status: entry.status, qr: entry.qr, phone: entry.phone };
}

function listSessions(organizationId) {
  const entry = sessions.get(organizationId);
  if (!entry) return [];
  return [{
    id: organizationId,
    label: entry.phone ? `WhatsApp ${entry.phone}` : 'Sesión de WhatsApp',
    phone: entry.phone,
    status: entry.status,
    hasQr: !!entry.qr
  }];
}

function emitStatus(organizationId) {
  emitToOrg(organizationId, 'whatsapp:status', publicStatus(organizationId));
}

// Accepts only genuine 1:1 person chats -- excludes groups, WhatsApp Channels (newsletters),
// broadcast lists, the status feed and bot/Meta-AI JIDs, all of which otherwise show up in
// messages.upsert and would otherwise be mistaken for real customer conversations.
function isRealPersonJid(jid) {
  if (isJidGroup(jid) || isJidNewsletter(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidBot(jid)) return false;
  return !!(isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid));
}

function jidUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function phoneFromJid(jid) {
  const server = String(jid || '').split('@')[1];
  // LIDs are WhatsApp's internal identifiers, not phone numbers. They must be
  // resolved through Baileys' mapping store before reaching the Contact model.
  if (server === 'lid' || server === 'hosted.lid') return null;
  const user = jidUser(jid);
  return user || null;
}

function jidFromPhone(phone) {
  return String(phone).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}

function isLidJid(jid) {
  return !!(isLidUser(jid) || isHostedLidUser(jid));
}

async function resolvePhoneJid(sock, jid) {
  if (!jid) return null;
  if (!isLidJid(jid)) return jid;

  const lidMapping = sock && sock.signalRepository && sock.signalRepository.lidMapping;
  if (!lidMapping || typeof lidMapping.getPNForLID !== 'function') return null;

  try {
    return await lidMapping.getPNForLID(jid);
  } catch (err) {
    console.warn('[whatsapp] no se pudo resolver el LID de WhatsApp', err.message || err);
    return null;
  }
}

async function rememberPhoneContacts(organizationId, contacts) {
  const entry = sessions.get(organizationId);
  if (!entry || !Array.isArray(contacts)) return;
  for (const contact of contacts) {
    const rawJid = contact && contact.id;
    if (!rawJid || !isRealPersonJid(rawJid)) continue;
    const resolvedJid = await resolvePhoneJid(entry.sock, rawJid);
    const phone = phoneFromJid(resolvedJid);
    if (!/^\d{6,}$/.test(phone)) continue;
    entry.phoneContacts.set(phone, {
      phone,
      name: contact.name || contact.notify || contact.verifiedName || null
    });
  }
}

function extractText(waMessage) {
  const m = waMessage.message;
  if (!m) return null;
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    null
  );
}

// Audios, fotos, videos, documentos y stickers que entran por WhatsApp. Antes se descartaban
// (solo se guardaba el texto); ahora se bajan, se guardan como adjunto y, si son notas de voz,
// se transcriben con Niro IA.
const MEDIA_KINDS = [
  { key: 'audioMessage', kind: 'audio', label: '🎤 Audio', fallbackMime: 'audio/ogg' },
  { key: 'imageMessage', kind: 'image', label: '🖼️ Imagen', fallbackMime: 'image/jpeg' },
  { key: 'videoMessage', kind: 'video', label: '🎬 Video', fallbackMime: 'video/mp4' },
  { key: 'documentMessage', kind: 'document', label: '📄 Documento', fallbackMime: 'application/pdf' },
  { key: 'stickerMessage', kind: 'sticker', label: '🩿 Sticker', fallbackMime: 'image/webp' }
];

function normalizeMime(mimetype, fallback) {
  const base = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (!base) return fallback;
  // WhatsApp manda las notas de voz como audio/ogg; codecs=opus, y algunos clientes usan
  // variantes que no están en la lista blanca de adjuntos.
  if (base === 'audio/ogg; codecs=opus' || base === 'audio/opus') return 'audio/ogg';
  if (base === 'audio/mp4' || base === 'audio/x-m4a') return 'audio/mp4';
  return base;
}

function extractMedia(waMessage) {
  const m = waMessage.message || {};
  for (const entry of MEDIA_KINDS) {
    const node = m[entry.key];
    if (!node) continue;
    const mimeType = normalizeMime(node.mimetype, entry.fallbackMime);
    const fileName = node.fileName || `${entry.kind}-${Date.now()}${extensionFor(mimeType) || ''}`;
    return {
      kind: entry.kind,
      label: entry.label,
      mimeType,
      fileName: String(fileName).slice(0, 180),
      isVoiceNote: entry.kind === 'audio' && !!node.ptt,
      seconds: node.seconds || null
    };
  }
  return null;
}

async function downloadInboundMedia(sock, waMessage, media) {
  if (!isAllowedMimeType(media.mimeType)) {
    console.warn('[whatsapp] adjunto entrante con tipo no permitido:', media.mimeType);
    return null;
  }
  try {
    const buffer = await downloadMediaMessage(waMessage, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage
    });
    if (!buffer || !buffer.length) return null;
    return buffer;
  } catch (err) {
    console.error('[whatsapp] no se pudo descargar el adjunto entrante', err.message || err);
    return null;
  }
}

function extractQuoted(waMessage) {
  const m = waMessage.message;
  const ctx = m && m.extendedTextMessage && m.extendedTextMessage.contextInfo;
  if (!ctx || !ctx.quotedMessage) return null;
  const qm = ctx.quotedMessage;
  const preview = qm.conversation || (qm.extendedTextMessage && qm.extendedTextMessage.text) || '[adjunto]';
  return {
    waMessageId: ctx.stanzaId || null,
    preview: String(preview).slice(0, 200),
    sender: ctx.participant && ctx.participant !== waMessage.key.remoteJid ? 'Cliente' : null
  };
}

// Fetches and stores a contact's WhatsApp profile picture URL, best-effort. Many users have no
// picture or a private one, so a failure here is expected/routine, not an error worth surfacing.
async function ensureContactAvatar(sock, contact, jid) {
  if (contact.avatarUrl) return contact;
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    if (!url) return contact;
    return await prisma.contact.update({ where: { id: contact.id }, data: { avatarUrl: url } });
  } catch {
    return contact;
  }
}

async function connect(organizationId) {
  const existing = sessions.get(organizationId);
  if (existing && ['connecting', 'qr', 'connected'].includes(existing.status)) {
    return publicStatus(organizationId);
  }

  const dir = sessionDir(organizationId);
  fs.mkdirSync(dir, { recursive: true });
  const authState = await useMultiFileAuthState(dir);
  const state = authState.state;
  const saveCreds = authState.saveCreds;
  const versionInfo = await fetchLatestBaileysVersion();

  const entry = { sock: null, status: 'connecting', qr: null, phone: null, phoneContacts: new Map() };
  sessions.set(organizationId, entry);
  emitStatus(organizationId);

  const sock = makeWASocket({
    version: versionInfo.version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: process.env.WHATSAPP_SYNC_FULL_HISTORY !== 'false'
  });
  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messaging-history.set', (payload) => {
    rememberPhoneContacts(organizationId, payload && payload.contacts)
      .catch((err) => console.error('[whatsapp] contact mapping failed', err));
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    rememberPhoneContacts(organizationId, contacts)
      .catch((err) => console.error('[whatsapp] contact mapping failed', err));
  });

  sock.ev.on('connection.update', async (update) => {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;
    const qr = update.qr;

    if (qr) {
      try {
        entry.qr = await QRCode.toDataURL(qr);
        entry.status = 'qr';
        emitStatus(organizationId);
      } catch (err) {
        console.error('[whatsapp] failed to render QR', err);
      }
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.phone = (sock.user && sock.user.id) ? phoneFromJid(sock.user.id) : null;
      emitStatus(organizationId);
    }

    if (connection === 'close') {
      const errOutput = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output;
      const statusCode = errOutput ? errOutput.statusCode : null;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      sessions.delete(organizationId);

      if (loggedOut) {
        fs.rmSync(dir, { recursive: true, force: true });
        emitToOrg(organizationId, 'whatsapp:status', { status: 'disconnected', qr: null, phone: null });
      } else {
        emitToOrg(organizationId, 'whatsapp:status', { status: 'connecting', qr: null, phone: null });
        connect(organizationId).catch((err) => console.error('[whatsapp] reconnect failed', err));
      }
    }
  });

  sock.ev.on('messages.upsert', (payload) => {
    if (payload.type !== 'notify') return;
    for (const waMessage of payload.messages) {
      handleInboundMessage(organizationId, sock, waMessage).catch((err) => console.error('[whatsapp] inbound message error', err));
    }
  });

  sock.ev.on('messages.reaction', (reactions) => {
    for (const item of reactions) {
      handleInboundReaction(organizationId, sock, item).catch((err) => console.error('[whatsapp] inbound reaction error', err));
    }
  });

  sock.ev.on('messages.update', (updates) => {
    const campaigns = require('./campaigns');
    for (const update of updates) {
      const statusLevel = update.update && typeof update.update.status === 'number' ? update.update.status : null;
      if (statusLevel === null || !update.key || !update.key.id) continue;
      campaigns.handleDeliveryUpdate(update.key.id, statusLevel).catch((err) => console.error('[whatsapp] delivery update error', err));
    }
  });

  return publicStatus(organizationId);
}

// Called once at server boot: every org that has a previously-linked session (a creds.json
// left on disk by useMultiFileAuthState) gets reconnected automatically, so a server restart
// doesn't force re-scanning a QR code for a number that's already paired.
async function resumeSessions() {
  if (!fs.existsSync(SESSION_ROOT)) return;
  const entries = fs.readdirSync(SESSION_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const credsPath = path.join(SESSION_ROOT, entry.name, 'creds.json');
    if (!fs.existsSync(credsPath)) continue;
    connect(entry.name).catch((err) => console.error('[whatsapp] resume failed for', entry.name, err));
  }
}

async function disconnect(organizationId) {
  const entry = sessions.get(organizationId);
  if (entry && entry.sock) {
    try {
      await entry.sock.logout();
    } catch (err) {
      console.error('[whatsapp] logout error', err);
    }
  }
  sessions.delete(organizationId);
  fs.rmSync(sessionDir(organizationId), { recursive: true, force: true });
  emitToOrg(organizationId, 'whatsapp:status', { status: 'disconnected', qr: null, phone: null });
}

async function syncContacts(organizationId) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected') {
    const error = new Error('Conectá WhatsApp antes de sincronizar los contactos del teléfono');
    error.status = 409;
    throw error;
  }
  if (entry.phoneContacts.size === 0) {
    const error = new Error('WhatsApp todavía no entregó la libreta de contactos. Volvé a conectar la sesión con la sincronización de historial habilitada');
    error.status = 409;
    throw error;
  }

  let imported = 0;
  let updated = 0;
  for (const candidate of entry.phoneContacts.values()) {
    const existing = await prisma.contact.findFirst({ where: { organizationId, phone: candidate.phone } });
    if (existing) {
      if (!existing.name && candidate.name) {
        await prisma.contact.update({ where: { id: existing.id }, data: { name: candidate.name } });
        updated += 1;
      }
      continue;
    }
    await prisma.contact.create({ data: { organizationId, phone: candidate.phone, name: candidate.name } });
    imported += 1;
  }
  return { imported, updated, total: entry.phoneContacts.size };
}

async function handleInboundMessage(organizationId, sock, waMessage) {
  if (waMessage.key.fromMe) return;
  const rawJid = waMessage.key.remoteJid;
  if (!rawJid || !isRealPersonJid(rawJid)) return;

  const media = extractMedia(waMessage);
  const caption = extractText(waMessage);
  if (!caption && !media) return;

  const resolvedJid = await resolvePhoneJid(sock, rawJid);
  const phone = phoneFromJid(resolvedJid);
  const rawUser = jidUser(rawJid);
  const quoted = extractQuoted(waMessage);

  // Prefer the real phone, then the external JID. The raw LID fallback also
  // upgrades contacts created by older versions that incorrectly stored the
  // LID digits in `phone`.
  const contactWhere = phone
    ? {
        organizationId,
        OR: [{ phone }, { externalId: rawJid }, ...(rawUser ? [{ phone: rawUser }] : [])]
      }
    : { organizationId, externalId: rawJid };
  let contact = await prisma.contact.findFirst({ where: contactWhere });
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        organizationId,
        phone: phone || null,
        externalId: rawJid,
        name: waMessage.pushName || null
      }
    });
  } else if (phone && (contact.phone !== phone || contact.externalId !== rawJid)) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: { phone, externalId: rawJid }
    });
  }
  contact = await ensureContactAvatar(sock, contact, resolvedJid || rawJid);

  let conversation = await prisma.conversation.findFirst({
    where: { organizationId: organizationId, contactId: contact.id, channel: 'whatsapp', status: { not: 'CLOSED' } },
    orderBy: { updatedAt: 'desc' },
    include: CONVERSATION_INCLUDE
  });

  const isNewConversation = !conversation;
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { organizationId: organizationId, contactId: contact.id, channel: 'whatsapp' },
      include: CONVERSATION_INCLUDE
    });
  }

  // Media: download, store as an attachment and (best-effort) run it through Niro IA —
  // voice notes get transcribed, photos get OCR'd. A download/IA failure never blocks the
  // message from landing in the inbox; it just falls back to a text-only message.
  let attachmentCreate = null;
  let mediaBuffer = null;
  if (media) {
    mediaBuffer = await downloadInboundMedia(sock, waMessage, media);
    if (mediaBuffer) {
      const storageKey = await saveFile(organizationId, mediaBuffer, extensionFor(media.mimeType));
      attachmentCreate = {
        create: { organizationId, fileName: media.fileName, mimeType: media.mimeType, size: mediaBuffer.length, storageKey }
      };
    }
  }

  const content = caption || (media ? media.label : '');
  const contentType = media ? (attachmentCreate ? media.kind : `${media.kind}-failed`) : 'text';

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderUserId: null,
      direction: 'INBOUND',
      content: content.slice(0, 4000),
      contentType,
      waMessageId: waMessage.key.id || null,
      quotedMessageId: null,
      quotedPreview: quoted ? quoted.preview : null,
      quotedSender: quoted ? quoted.sender : null,
      ...(attachmentCreate ? { attachment: attachmentCreate } : {})
    },
    include: MESSAGE_INCLUDE
  });

  let updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
    include: CONVERSATION_INCLUDE
  });

  broadcastMessage(organizationId, conversation.id, message);
  emitToOrg(organizationId, isNewConversation ? 'conversation:new' : 'conversation:updated', {
    conversation: sanitizeConversation(updated)
  });

  // Transcription/OCR happen after the message already reached the inbox in real time, then
  // patch the row and tell connected clients so the text appears without a reload.
  if (mediaBuffer && media.kind === 'audio') {
    transcribeMessageAudio(message.id, mediaBuffer, media.fileName, media.mimeType).then((transcript) => {
      if (!transcript) return;
      emitToOrg(organizationId, 'message:updated', {
        conversationId: conversation.id,
        message: sanitizeMessage({ ...message, transcription: transcript })
      });
    });
  }

  const settings = await prisma.organizationSettings.findUnique({
    where: { organizationId: organizationId },
    include: { organization: { select: { name: true } } }
  });
  const organizationName = settings && settings.organization ? settings.organization.name : null;

  if (isNewConversation) {
    if (settings && settings.aiEnabled) {
      const welcome = renderWelcome(settings);
      await sendBotMessage(conversation.id, organizationId, welcome);
      if (phone) {
        await sendText(organizationId, phone, welcome).catch((err) => console.error('[whatsapp] welcome send failed', err));
      }
    }
    return;
  }

  if (!updated.departmentId && settings && settings.aiEnabled) {
    const option = caption ? matchMenuOption(settings, caption) : null;
    if (option) {
      updated = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { departmentId: option.departmentId },
        include: CONVERSATION_INCLUDE
      });
      const reply = 'Te derivamos a ' + option.label + '. En un momento te atienden.';
      await sendBotMessage(conversation.id, organizationId, reply);
      if (phone) {
        await sendText(organizationId, phone, reply).catch((err) => console.error('[whatsapp] routing reply send failed', err));
      }
      emitToOrg(organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
      return;
    }
  }

  // No menu option matched (or there's no menu at all): let the AI answer freely, using the
  // conversation history, as long as no human agent has claimed the chat yet.
  if (aiBot.shouldReply(updated, settings)) {
    const reply = await aiBot.generateReply(conversation.id, settings, organizationName);
    if (reply && reply.content) {
      await sendBotMessage(conversation.id, organizationId, reply.content);
      if (phone) {
        await sendText(organizationId, phone, reply.content).catch((err) => console.error('[whatsapp] ai reply send failed', err));
      }
    }
  }
}

async function handleInboundReaction(organizationId, sock, item) {
  const rawJid = item.key.remoteJid;
  if (!rawJid || !isRealPersonJid(rawJid)) return;
  const resolvedJid = await resolvePhoneJid(sock, rawJid);
  const phone = phoneFromJid(resolvedJid);
  const targetWaMessageId = item.key.id;
  const emoji = item.reaction && item.reaction.text ? item.reaction.text : null;

  const contact = await prisma.contact.findFirst({
    where: phone ? { organizationId, phone } : { organizationId, externalId: rawJid }
  });
  if (!contact) return;

  const message = await prisma.message.findFirst({
    where: { waMessageId: targetWaMessageId, conversation: { organizationId, contactId: contact.id } }
  });
  if (!message) return;

  const current = Array.isArray(message.reactions) ? message.reactions : [];
  const withoutCustomer = current.filter((r) => r.from !== 'customer');
  const nextReactions = emoji ? [...withoutCustomer, { emoji, from: 'customer', at: new Date().toISOString() }] : withoutCustomer;

  const updatedMessage = await prisma.message.update({
    where: { id: message.id },
    data: { reactions: nextReactions },
    include: MESSAGE_INCLUDE
  });

  emitToOrg(organizationId, 'message:updated', {
    conversationId: updatedMessage.conversationId,
    message: sanitizeMessage(updatedMessage)
  });
}

async function sendText(organizationId, phone, content, options) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    throw new Error('WhatsApp no esta conectado para esta organizacion');
  }
  const jid = jidFromPhone(phone);
  const sendOpts = buildQuoteOptions(jid, options);
  const sent = await entry.sock.sendMessage(jid, { text: content }, sendOpts);
  return sent && sent.key ? sent.key.id : null;
}

async function sendMedia(organizationId, phone, opts) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    throw new Error('WhatsApp no esta conectado para esta organizacion');
  }
  const jid = jidFromPhone(phone);
  const buffer = opts.buffer;
  const mimetype = opts.mimetype;
  const fileName = opts.fileName;
  const caption = opts.caption;
  const sendOpts = buildQuoteOptions(jid, opts);

  let sent;
  if (opts.kind === 'sticker') {
    sent = await entry.sock.sendMessage(jid, { sticker: buffer }, sendOpts);
  } else if (mimetype.indexOf('image/') === 0) {
    sent = await entry.sock.sendMessage(jid, { image: buffer, mimetype: mimetype, caption: caption }, sendOpts);
  } else if (mimetype.indexOf('video/') === 0) {
    sent = await entry.sock.sendMessage(jid, { video: buffer, mimetype: mimetype, caption: caption }, sendOpts);
  } else if (mimetype.indexOf('audio/') === 0) {
    sent = await entry.sock.sendMessage(jid, { audio: buffer, mimetype: mimetype, ptt: !!opts.ptt }, sendOpts);
  } else {
    sent = await entry.sock.sendMessage(jid, { document: buffer, mimetype: mimetype, fileName: fileName }, sendOpts);
  }
  return sent && sent.key ? sent.key.id : null;
}

async function deleteMessage(organizationId, phone, targetWaMessageId, targetFromMe) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    throw new Error('WhatsApp no esta conectado para esta organizacion');
  }
  const jid = jidFromPhone(phone);
  await entry.sock.sendMessage(jid, { delete: { remoteJid: jid, id: targetWaMessageId, fromMe: !!targetFromMe } });
}
async function sendReaction(organizationId, phone, targetWaMessageId, targetFromMe, emoji) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    throw new Error('WhatsApp no esta conectado para esta organizacion');
  }
  const jid = jidFromPhone(phone);
  await entry.sock.sendMessage(jid, {
    react: { text: emoji || '', key: { remoteJid: jid, id: targetWaMessageId, fromMe: !!targetFromMe } }
  });
}

async function sendPoll(organizationId, phone, question, options) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    throw new Error('WhatsApp no esta conectado para esta organizacion');
  }
  const jid = jidFromPhone(phone);
  const sent = await entry.sock.sendMessage(jid, { poll: { name: question, values: options, selectableCount: 1 } });
  return sent && sent.key ? sent.key.id : null;
}

function buildVcard(name, phone) {
  const digits = String(phone).replace(/[^0-9]/g, '');
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `TEL;type=CELL;waid=${digits}:+${digits}`,
    'END:VCARD'
  ].join('\n');
}

async function sendContactCard(organizationId, phone, contactName, contactPhone) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    throw new Error('WhatsApp no esta conectado para esta organizacion');
  }
  const jid = jidFromPhone(phone);
  const vcard = buildVcard(contactName, contactPhone);
  const sent = await entry.sock.sendMessage(jid, {
    contacts: { displayName: contactName, contacts: [{ displayName: contactName, vcard: vcard }] }
  });
  return sent && sent.key ? sent.key.id : null;
}

function buildQuoteOptions(jid, options) {
  if (!options || !options.quoted || !options.quoted.waMessageId) return {};
  return {
    quoted: {
      key: { remoteJid: jid, id: options.quoted.waMessageId, fromMe: !!options.quoted.fromMe },
      message: { conversation: options.quoted.preview || '' }
    }
  };
}

module.exports = {
  connect: connect,
  disconnect: disconnect,
  resumeSessions: resumeSessions,
  getStatus: publicStatus,
  listSessions: listSessions,
  syncContacts: syncContacts,
  sendText: sendText,
  sendMedia: sendMedia,
  sendReaction: sendReaction,
  deleteMessage: deleteMessage,
  sendPoll: sendPoll,
  sendContactCard: sendContactCard,
  isRealPersonJid: isRealPersonJid,
  phoneFromJid: phoneFromJid,
  resolvePhoneJid: resolvePhoneJid
};
