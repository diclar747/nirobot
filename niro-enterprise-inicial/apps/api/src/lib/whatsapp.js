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
const { runBotFlow, conversationUpdateData } = require('./botFlow');
const { registerInboundResponse } = require('./callSurveys');
const aiBot = require('./aiBot');
const push = require('./push');
const { saveFile } = require('./storage');
const { isAllowedMimeType, extensionFor, normalizeMimeType } = require('./attachments');
const { convertToWhatsAppVoiceNote } = require('./voiceNote');
const { CONVERSATION_INCLUDE, MESSAGE_INCLUDE, sanitizeConversation, sanitizeMessage, broadcastMessage, sendBotMessage } = require('./conversations');

const SESSION_ROOT = process.env.WHATSAPP_SESSION_ROOT || path.join(__dirname, '..', '..', 'storage', 'whatsapp-sessions');
// Identidad visible en WhatsApp > Dispositivos vinculados. Baileys usa
// `browser[1] (browser[0])` como nombre del dispositivo; no queremos exponer
// el valor predeterminado "Chrome (Mac OS)" del socket.
const NIRO_BROWSER = ['Niro', 'Niro Bot', '1.0.0'];

const sessions = new Map();
const connectionPromises = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const lastDisconnectErrors = new Map();
const sessionAvatars = new Map();
const sessionProfileNames = new Map();
const CALL_SOCKET_SETTLE_MS = Math.max(500, Number(process.env.WHATSAPP_CALL_SOCKET_SETTLE_MS || 1800));

function waitForSocketSettle() {
  return new Promise((resolve) => setTimeout(resolve, CALL_SOCKET_SETTLE_MS));
}

function scheduleReconnect(organizationId) {
  if (reconnectTimers.has(organizationId)) return;
  const attempt = Math.min((reconnectAttempts.get(organizationId) || 0) + 1, 6);
  const delayMs = Math.min(30000, 1500 * (2 ** (attempt - 1)));
  reconnectAttempts.set(organizationId, attempt);
  const timer = setTimeout(() => {
    reconnectTimers.delete(organizationId);
    connect(organizationId)
      .then((status) => {
        if (status.status === 'connected') reconnectAttempts.delete(organizationId);
      })
      .catch((err) => console.error('[whatsapp] reconnect failed', err));
  }, delayMs);
  timer.unref?.();
  reconnectTimers.set(organizationId, timer);
}

function sessionDir(organizationId) {
  return path.join(SESSION_ROOT, organizationId);
}

function linkedMarkerPath(organizationId) {
  return path.join(sessionDir(organizationId), 'linked.json');
}

function hasStoredSession(organizationId) {
  const credsPath = path.join(sessionDir(organizationId), 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    // Baileys creates creds.json before the QR is completed. Treating that
    // partial state as a linked session leaves the UI stuck on RECONNECTING
    // after a restart and prevents the user from requesting a fresh QR.
    if (!creds.me) return false;
    if (creds.registered !== false) return true;
    if (fs.existsSync(linkedMarkerPath(organizationId))) return true;

    // Baileys 7 can leave registered=false after a successful linked-device
    // handshake. The persisted app-state/device files are stronger evidence
    // than that flag and let the session survive an API restart.
    const files = fs.readdirSync(sessionDir(organizationId));
    return files.some((name) => name.startsWith('app-state-sync-version-'))
      && files.some((name) => name.startsWith('device-list-'));
  } catch {
    return false;
  }
}

function hasPartialSession(organizationId) {
  const credsPath = path.join(sessionDir(organizationId), 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  if (hasStoredSession(organizationId)) return false;
  try {
    return JSON.parse(fs.readFileSync(credsPath, 'utf8')).registered === false;
  } catch {
    return true;
  }
}

function rotatePartialSession(organizationId) {
  if (!hasPartialSession(organizationId)) return;
  const dir = sessionDir(organizationId);
  const backupDir = `${dir}.pending-${Date.now()}`;
  fs.renameSync(dir, backupDir);
  console.warn(`[whatsapp] sesión parcial respaldada en ${path.basename(backupDir)}; se generará un QR nuevo`);
}

function publicStatus(organizationId) {
  const entry = sessions.get(organizationId);
  const avatarUrl = entry?.avatarUrl || sessionAvatars.get(organizationId) || null;
  const profileName = entry?.profileName || sessionProfileNames.get(organizationId) || null;
  // Durante un reinicio el socket todavía puede estar reconstruyéndose, pero las
  // credenciales persistidas ya demuestran que la empresa sigue vinculada. Mostrar
  // "connecting" evita que la UI la marque como desconectada y evita pedir otro QR.
  if (!entry) {
    return hasStoredSession(organizationId)
      ? { status: 'connecting', qr: null, phone: null, avatarUrl, profileName, lastError: lastDisconnectErrors.get(organizationId) || null }
      : { status: 'disconnected', qr: null, phone: null, avatarUrl, profileName, lastError: lastDisconnectErrors.get(organizationId) || null };
  }
  return { status: entry.status, qr: entry.qr, phone: entry.phone, avatarUrl, profileName, lastError: entry.lastError || null };
}

async function refreshSessionAvatar(organizationId, entry, sock) {
  const jid = sock?.user?.id;
  const fallback = typeof sock?.user?.imgUrl === 'string' ? sock.user.imgUrl : null;
  if (!jid || typeof sock.profilePictureUrl !== 'function') {
    entry.avatarUrl = fallback;
    if (fallback) sessionAvatars.set(organizationId, fallback);
    return;
  }

  try {
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      timer.unref?.();
    });
    const profileUrl = await Promise.race([
      sock.profilePictureUrl(jid, 'image').catch(() => null),
      timeout
    ]);
    const avatarUrl = typeof profileUrl === 'string' && /^https?:\/\//i.test(profileUrl)
      ? profileUrl
      : fallback;
    entry.avatarUrl = avatarUrl || null;
    if (entry.avatarUrl) sessionAvatars.set(organizationId, entry.avatarUrl);
  } catch {
    entry.avatarUrl = fallback;
    if (fallback) sessionAvatars.set(organizationId, fallback);
  }
}

// Keep the persisted call-account status aligned with the live Baileys socket.
// The UI can read the live status, but other screens and background jobs read
// CallAccount from the database. Without this sync, a healthy phone session can
// remain stuck as RECONNECTING after a restart.
function syncCallAccountState(organizationId, status, phone = null, lastError = null) {
  prisma.callAccount.findFirst({
    where: { organizationId },
    orderBy: { createdAt: 'asc' }
  }).then((account) => {
    if (!account) return null;
    return prisma.callAccount.update({
      where: { id: account.id },
      data: {
        status,
        ...(phone ? { phoneNumber: phone } : {}),
        sessionReference: sessionDir(organizationId),
        lastError
      }
    });
  }).catch((err) => {
    console.error(`[whatsapp] no se pudo sincronizar el estado de la cuenta ${organizationId}:`, err.message || err);
  });
}

function listSessions(organizationId) {
  const entry = sessions.get(organizationId);
  if (!entry && !hasStoredSession(organizationId)) return [];
  if (!entry) {
    return [{
      id: organizationId,
      label: 'Sesión de WhatsApp',
      phone: null,
      status: 'connecting',
      hasQr: false
    }];
  }
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

async function resolveBaileysVersion() {
  const timeoutMs = Math.max(1000, Number(process.env.WHATSAPP_VERSION_TIMEOUT_MS || 8000));
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const latest = fetchLatestBaileysVersion()
      .then((result) => (result && result.version ? result : null))
      .catch((err) => {
        console.warn('[whatsapp] no se pudo consultar la versión más reciente de Baileys; se usará la integrada:', err.message || err);
        return null;
      });
    const result = await Promise.race([latest, timeout]);
    if (!result) console.warn(`[whatsapp] consulta de versión agotó ${timeoutMs} ms; se usará la versión integrada`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
// (solo se guardaba el texto); ahora se bajan y se guardan como adjunto, preservando el contenido
// original sin transcripción ni OCR automático.
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
    // Profile pictures are optional enrichment. A slow/unreachable WhatsApp
    // profile endpoint must never delay the inbound message event reaching the
    // inbox in real time.
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);
      timer.unref?.();
    });
    const url = await Promise.race([
      sock.profilePictureUrl(jid, 'image').catch(() => null),
      timeout
    ]);
    if (!url) return contact;
    return await prisma.contact.update({ where: { id: contact.id }, data: { avatarUrl: url } });
  } catch {
    return contact;
  }
}

function connect(organizationId, options = {}) {
  const pending = connectionPromises.get(organizationId);
  if (pending) return pending;

  const promise = connectSession(organizationId, options);
  connectionPromises.set(organizationId, promise);
  promise.finally(() => {
    if (connectionPromises.get(organizationId) === promise) connectionPromises.delete(organizationId);
  }).catch(() => {});
  return promise;
}

async function connectSession(organizationId, options = {}) {
  const existing = sessions.get(organizationId);
  if (existing && ['connecting', 'qr', 'connected'].includes(existing.status)) {
    return publicStatus(organizationId);
  }

  if (options.fresh) rotatePartialSession(organizationId);
  const dir = sessionDir(organizationId);
  fs.mkdirSync(dir, { recursive: true });
  const authState = await useMultiFileAuthState(dir);
  const state = authState.state;
  const saveCreds = authState.saveCreds;
  const versionInfo = await resolveBaileysVersion();

  const entry = { sock: null, status: 'connecting', qr: null, phone: null, avatarUrl: sessionAvatars.get(organizationId) || null, profileName: sessionProfileNames.get(organizationId) || null, lastError: null, phoneContacts: new Map(), pausedForCall: false };
  sessions.set(organizationId, entry);
  emitStatus(organizationId);

  const sockOptions = {
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: NIRO_BROWSER,
    syncFullHistory: process.env.WHATSAPP_SYNC_FULL_HISTORY !== 'false'
  };
  // If GitHub is unavailable, Baileys already knows a compatible bundled version.
  if (versionInfo && versionInfo.version) sockOptions.version = versionInfo.version;
  const sock = makeWASocket(sockOptions);
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
        syncCallAccountState(organizationId, 'WAITING_AUTH');
        console.log(`[whatsapp] QR listo para la organización ${organizationId}`);
        emitStatus(organizationId);
      } catch (err) {
        console.error('[whatsapp] failed to render QR', err);
      }
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.lastError = null;
      lastDisconnectErrors.delete(organizationId);
      entry.phone = (sock.user && sock.user.id) ? phoneFromJid(sock.user.id) : null;
      const profileName = [sock.user?.name, sock.user?.verifiedName]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find(Boolean) || null;
      entry.profileName = profileName || sessionProfileNames.get(organizationId) || null;
      if (entry.profileName) sessionProfileNames.set(organizationId, entry.profileName);
      await refreshSessionAvatar(organizationId, entry, sock);
      reconnectAttempts.delete(organizationId);
      fs.writeFileSync(linkedMarkerPath(organizationId), JSON.stringify({
        phone: entry.phone,
        linkedAt: new Date().toISOString()
      }));
      syncCallAccountState(organizationId, 'CONNECTED', entry.phone);
      emitStatus(organizationId);
    }

    if (connection === 'close') {
      const errOutput = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output;
      const statusCode = errOutput ? errOutput.statusCode : null;
      const disconnectMessage = lastDisconnect?.error?.message || 'sin detalle';
      // WhatsApp/Baileys can report a temporary socket collision or a failed
      // transport with HTTP 401. Neither means that the phone was unlinked.
      // Only an explicit logout/device-removal reason may delete credentials.
      const socketConflict = statusCode === 440 || /conflict|connection failure/i.test(disconnectMessage);
      const explicitLogout = /logged[ -]?out|device[ _-]?removed|device[ _-]?revoked|session[ _-]?invalid/i.test(disconnectMessage);
      const loggedOut = statusCode === DisconnectReason.loggedOut && !socketConflict && explicitLogout;
      entry.lastError = disconnectMessage;
      lastDisconnectErrors.set(organizationId, disconnectMessage);
      console.warn(`[whatsapp] conexión cerrada para ${organizationId}; código=${statusCode || 'desconocido'}; logout=${loggedOut}; detalle=${disconnectMessage}`);

      // Calls use baileys-caller, which must temporarily own the WhatsApp
      // socket. Do not treat this intentional hand-off as a network failure
      // and, more importantly, do not start a reconnect while the call socket
      // is using the same persisted credentials.
      if (entry.pausedForCall) {
        if (sessions.get(organizationId) === entry) sessions.delete(organizationId);
        emitToOrg(organizationId, 'whatsapp:status', { status: 'connecting', qr: null, phone: null, avatarUrl: entry.avatarUrl || sessionAvatars.get(organizationId) || null });
        return;
      }

      sessions.delete(organizationId);

      if (loggedOut) {
        reconnectAttempts.delete(organizationId);
        const pendingTimer = reconnectTimers.get(organizationId);
        if (pendingTimer) clearTimeout(pendingTimer);
        reconnectTimers.delete(organizationId);
        fs.rmSync(dir, { recursive: true, force: true });
        sessionAvatars.delete(organizationId);
        sessionProfileNames.delete(organizationId);
        syncCallAccountState(organizationId, 'DISCONNECTED', null, disconnectMessage);
        emitToOrg(organizationId, 'whatsapp:status', { status: 'disconnected', qr: null, phone: null, lastError: disconnectMessage });
      } else if ((statusCode === DisconnectReason.timedOut || statusCode === 408) && !hasStoredSession(organizationId)) {
        // An unlinked QR that expires must wait for an explicit refresh. A
        // persisted linked session is different: the phone is still linked and
        // the server should rebuild its socket automatically after a timeout.
        reconnectAttempts.delete(organizationId);
        syncCallAccountState(organizationId, 'DISCONNECTED', null, disconnectMessage);
        emitToOrg(organizationId, 'whatsapp:status', { status: 'disconnected', qr: null, phone: null, lastError: disconnectMessage });
      } else {
        // Keep linked sessions alive across transient socket/network failures.
        // Baileys can close with 408 while the linked device remains valid.
        syncCallAccountState(organizationId, 'RECONNECTING', null, disconnectMessage);
        emitToOrg(organizationId, 'whatsapp:status', { status: 'connecting', qr: null, phone: null, avatarUrl: entry.avatarUrl || sessionAvatars.get(organizationId) || null, lastError: disconnectMessage });
        scheduleReconnect(organizationId);
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

// baileys-caller creates its own Baileys socket. Keeping the chat socket open
// at the same time causes WhatsApp to close one of them with conflict 440.
// Pause only the transport; credentials remain on disk and are never logged
// out, so the phone stays linked and the chat resumes after the call.
async function pauseForCall(organizationId) {
  const pendingTimer = reconnectTimers.get(organizationId);
  if (pendingTimer) clearTimeout(pendingTimer);
  reconnectTimers.delete(organizationId);

  const entry = sessions.get(organizationId);
  if (!entry || !entry.sock) return false;
  entry.pausedForCall = true;
  try {
    await entry.sock.end();
  } catch (err) {
    console.warn('[whatsapp] no se pudo pausar el socket antes de la llamada:', err.message || err);
  }
  // Baileys closes the websocket asynchronously. Give it time to release the
  // linked-device transport before baileys-caller opens its own socket with
  // the same credentials, otherwise WhatsApp can report conflict 440.
  await waitForSocketSettle();
  if (sessions.get(organizationId) === entry) sessions.delete(organizationId);
  emitToOrg(organizationId, 'whatsapp:status', { status: 'connecting', qr: null, phone: null });
  return true;
}

async function resumeAfterCall(organizationId) {
  if (!hasStoredSession(organizationId)) return publicStatus(organizationId);
  const current = sessions.get(organizationId);
  if (current && ['connecting', 'qr', 'connected'].includes(current.status)) return publicStatus(organizationId);
  const status = await connect(organizationId);
  return status;
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
    // A creds.json with registered=false is created before the QR is scanned.
    // It is not a linked WhatsApp session and must not be resumed after a restart;
    // doing so makes Baileys reuse an expired pairing and can leave the UI stuck.
    if (!hasStoredSession(entry.name)) {
      console.warn(`[whatsapp] se omite la sesión parcial ${entry.name}; se solicitará un QR nuevo`);
      continue;
    }
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
  lastDisconnectErrors.delete(organizationId);
  fs.rmSync(sessionDir(organizationId), { recursive: true, force: true });
  emitToOrg(organizationId, 'whatsapp:status', { status: 'disconnected', qr: null, phone: null, lastError: null });
}

// Close transport sockets during an API restart without logging out the
// linked device. This prevents the next process from briefly competing with
// a still-open websocket (WhatsApp then reports conflict 440) while keeping
// creds.json and the phone pairing untouched.
async function shutdown() {
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  reconnectAttempts.clear();

  const entries = [...sessions.entries()];
  await Promise.all(entries.map(async ([organizationId, entry]) => {
    entry.pausedForCall = true;
    try {
      if (entry.sock) await entry.sock.end();
    } catch (err) {
      console.warn(`[whatsapp] cierre limpio omitido para ${organizationId}:`, err.message || err);
    } finally {
      if (sessions.get(organizationId) === entry) sessions.delete(organizationId);
    }
  }));
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

  if (phone) {
    await registerInboundResponse(organizationId, phone, caption).catch((err) => {
      console.error('[whatsapp] survey response error', err);
    });
  }

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

  // Baileys may replay an upsert after a reconnect. Do not create a duplicate
  // message, and make the real-time handler safe to retry.
  if (waMessage.key.id) {
    const alreadyStored = await prisma.message.findFirst({
      where: { waMessageId: waMessage.key.id, conversation: { organizationId } },
      select: { id: true }
    });
    if (alreadyStored) return;
  }

  // Media: download and store it as an attachment. The inbox must preserve the original
  // WhatsApp content as-is; no audio transcription or image OCR runs automatically here.
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

  push.notifyNewInboundMessage({
    organizationId,
    conversation: updated,
    contactLabel: contact.name || contact.phone || 'Cliente',
    preview: content,
    channel: 'whatsapp'
  });

  const settings = await prisma.organizationSettings.findUnique({
    where: { organizationId: organizationId },
    include: { organization: { select: { name: true } } }
  });
  const organizationName = settings && settings.organization ? settings.organization.name : null;

  if (isNewConversation) {
    const flowResult = settings ? runBotFlow(settings.botFlow, { content: caption, contact, conversation: updated, isNewConversation: true }) : null;
    if (flowResult) {
      const flowData = conversationUpdateData(updated, flowResult);
      if (Object.keys(flowData).length > 0) {
        updated = await prisma.conversation.update({ where: { id: conversation.id }, data: flowData, include: CONVERSATION_INCLUDE });
        emitToOrg(organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
      }
      for (const reply of flowResult.replies) {
        await sendBotMessage(conversation.id, organizationId, reply);
        if (phone) await sendText(organizationId, phone, reply).catch((err) => console.error('[whatsapp] flow welcome send failed', err));
      }
    } else if (settings && settings.aiEnabled) {
      const welcome = renderWelcome(settings);
      await sendBotMessage(conversation.id, organizationId, welcome);
      if (phone) {
        await sendText(organizationId, phone, welcome).catch((err) => console.error('[whatsapp] welcome send failed', err));
      }
    }
    return;
  }

  const flowResult = settings ? runBotFlow(settings.botFlow, { content: caption, contact, conversation: updated, isNewConversation: false }) : null;
  if (flowResult) {
    const flowData = conversationUpdateData(updated, flowResult);
    if (Object.keys(flowData).length > 0) {
      updated = await prisma.conversation.update({ where: { id: conversation.id }, data: flowData, include: CONVERSATION_INCLUDE });
    }
    for (const reply of flowResult.replies) {
      await sendBotMessage(conversation.id, organizationId, reply);
      if (phone) await sendText(organizationId, phone, reply).catch((err) => console.error('[whatsapp] flow reply send failed', err));
    }
    if (flowResult.useAi && aiBot.shouldReply(updated, settings)) {
      const aiSettings = flowResult.aiPrompt ? { ...settings, systemPrompt: `${settings.systemPrompt || ''} ${flowResult.aiPrompt}`.trim() } : settings;
      const reply = await aiBot.generateReply(conversation.id, aiSettings, organizationName);
      if (reply && reply.content) {
        await sendBotMessage(conversation.id, organizationId, reply.content);
        if (phone) await sendText(organizationId, phone, reply.content).catch((err) => console.error('[whatsapp] flow ai reply failed', err));
      }
    }
    emitToOrg(organizationId, 'conversation:updated', { conversation: sanitizeConversation(updated) });
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
  let buffer = opts.buffer;
  let mimetype = normalizeMimeType(opts.mimetype);
  const fileName = opts.fileName;
  const caption = opts.caption;
  const sendOpts = buildQuoteOptions(jid, opts);

  if (mimetype.startsWith('audio/') && opts.ptt) {
    const converted = await convertToWhatsAppVoiceNote(buffer, mimetype);
    buffer = converted.buffer;
    mimetype = converted.mimeType;
  }

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
  shutdown: shutdown,
  pauseForCall: pauseForCall,
  resumeAfterCall: resumeAfterCall,
  resumeSessions: resumeSessions,
  getStatus: publicStatus,
  listSessions: listSessions,
  syncContacts: syncContacts,
  getSessionReference: (organizationId) => sessionDir(organizationId),
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
