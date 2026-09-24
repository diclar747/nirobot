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
const { registerInboundResponse } = require('./callSurveys');
const { HANDOFF_TAG } = require('./botFlow');
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
const callOwnership = new Set();
const messageQueues = new Map();
const connectionPromises = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
// A linked session that keeps closing with a non-logout error (e.g. repeated
// "Connection Failure" 401s from a stale pairing) never recovers on its own.
// After this many consecutive automatic failures we stop retrying, keep the
// credentials, and surface a manual-reconnect state instead of looping forever.
const MAX_CONSECUTIVE_RECONNECT_FAILURES = 8;
const consecutiveFailures = new Map();
const stalledSessions = new Set();
// Sessions WhatsApp itself revoked (device_removed / repeated 401): the stored credentials are dead,
// so the only way back is a fresh QR. Tracked apart from "stalled" (transient) failures.
const relinkRequired = new Map();
const AUTH_REJECT_LIMIT = 3;
const authRejections = new Map();
// Inside SESSION_ROOT (same volume, so rename works) but as a hidden directory without creds.json, which
// resumeSessions() skips.
const REMOVED_SESSION_ROOT = path.join(SESSION_ROOT, '.removed');
const RELINK_MESSAGE = 'WhatsApp cerró la sesión de este dispositivo (se quitó de Dispositivos vinculados). Escaneá el QR para volver a vincular el número.';
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
    connect(organizationId, { auto: true })
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

// Moves dead credentials out of SESSION_ROOT (so a restart never tries to resume them) without
// destroying them.
function archiveSession(organizationId, label) {
  const dir = sessionDir(organizationId);
  if (!fs.existsSync(dir)) return;
  try {
    fs.mkdirSync(REMOVED_SESSION_ROOT, { recursive: true });
    const target = path.join(REMOVED_SESSION_ROOT, `${organizationId}-${label}-${Date.now()}`);
    try {
      fs.renameSync(dir, target);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.cpSync(dir, target, { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[whatsapp] no se pudo archivar la sesión de ${organizationId}: ${err.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isDeviceRemoved(error) {
  const data = error && error.data;
  if (!data) return false;
  const type = data.attrs && data.attrs.type;
  return /device[_-]?removed|replaced_by_logout/i.test(String(type || '')) && (data.tag === 'conflict' || data.tag === 'stream:error');
}

function publicStatus(organizationId) {
  const entry = sessions.get(organizationId);
  const avatarUrl = entry?.avatarUrl || sessionAvatars.get(organizationId) || null;
  const profileName = entry?.profileName || sessionProfileNames.get(organizationId) || null;
  // Durante un reinicio el socket todavía puede estar reconstruyéndose, pero las
  // credenciales persistidas ya demuestran que la empresa sigue vinculada. Mostrar
  // "connecting" evita que la UI la marque como desconectada y evita pedir otro QR.
  if (!entry) {
    if (relinkRequired.has(organizationId)) {
      return { status: 'disconnected', qr: null, phone: null, avatarUrl, profileName, needsRelink: true, lastError: relinkRequired.get(organizationId) };
    }
    if (stalledSessions.has(organizationId)) {
      return { status: 'disconnected', qr: null, phone: null, avatarUrl, profileName, needsManualReconnect: true, lastError: lastDisconnectErrors.get(organizationId) || 'La conexión falló repetidas veces. Reconecta o vuelve a vincular el número.' };
    }
    return hasStoredSession(organizationId)
      ? { status: 'connecting', qr: null, phone: null, avatarUrl, profileName, lastError: lastDisconnectErrors.get(organizationId) || null }
      : { status: 'disconnected', qr: null, phone: null, avatarUrl, profileName, lastError: lastDisconnectErrors.get(organizationId) || null };
  }
  return { status: entry.status, qr: entry.qr, phone: entry.phone, avatarUrl, profileName, lastError: entry.lastError || null };
}

// Importing the phone's history creates hundreds of contacts without a profile picture (the
// live-message path is the only one that fetches it). Fill them in slowly and in the
// background: WhatsApp rate-limits profile lookups, so never burst.
const AVATAR_BACKFILL_DELAY_MS = Math.max(300, Number(process.env.WHATSAPP_AVATAR_BACKFILL_DELAY_MS || 800));
const avatarBackfills = new Set();

// `sock.profilePictureUrl()` da un link firmado al CDN de WhatsApp que vence a las pocas horas —
// si se guarda tal cual en la base, la foto termina rota. Se descarga la imagen y se guarda en
// disco (mismo storage que el resto de los adjuntos); lo que se persiste es la storageKey, no el
// link. Devuelve la storageKey, o null si no se pudo descargar.
async function downloadAvatarToStorage(organizationId, sourceUrl) {
  try {
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const mime = normalizeMimeType(res.headers.get('content-type'));
    const ext = extensionFor(mime) || '.jpg';
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return null;
    return await saveFile(organizationId, buffer, ext);
  } catch {
    return null;
  }
}

async function backfillContactAvatars(organizationId, sock, { onProgress } = {}) {
  if (avatarBackfills.has(organizationId)) return { started: false };
  avatarBackfills.add(organizationId);
  const skipped = new Set();
  let fetched = 0;
  let noPicture = 0;
  let consecutiveErrors = 0;
  try {
    for (;;) {
      const entry = sessions.get(organizationId);
      if (!entry || entry.sock !== sock || entry.status !== 'connected' || entry.pausedForCall) break;
      // Most recently active chats first: those are the ones the agent is looking at.
      const batch = await prisma.contact.findMany({
        where: { organizationId, avatarUrl: null, id: { notIn: [...skipped] }, OR: [{ phone: { not: null } }, { externalId: { not: null } }] },
        orderBy: [{ conversations: { _count: 'desc' } }, { createdAt: 'desc' }],
        take: 25,
        select: { id: true, phone: true, externalId: true }
      });
      if (batch.length === 0) break;
      for (const contact of batch) {
        const current = sessions.get(organizationId);
        if (!current || current.sock !== sock || current.status !== 'connected' || current.pausedForCall) return { started: true, fetched, noPicture, interrupted: true };
        const jid = contact.externalId && /@(s\.whatsapp\.net|lid)$/.test(contact.externalId) ? contact.externalId : (contact.phone ? jidFromPhone(contact.phone) : null);
        skipped.add(contact.id);
        if (onProgress) await onProgress({ processed: fetched + noPicture });
        if (!jid) continue;
        try {
          const url = await Promise.race([
            sock.profilePictureUrl(jid, 'image'),
            new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 8000); t.unref?.(); })
          ]);
          consecutiveErrors = 0;
          const key = typeof url === 'string' && /^https?:\/\//i.test(url) ? await downloadAvatarToStorage(organizationId, url) : null;
          if (key) {
            await prisma.contact.update({ where: { id: contact.id }, data: { avatarUrl: key } });
            fetched += 1;
          }
        } catch (err) {
          const message = String(err?.message || err);
          if (/item-not-found|not-authorized|forbidden|404|401/i.test(message)) {
            // No picture, or hidden by privacy settings: remember it so it is not asked again.
            await prisma.contact.update({ where: { id: contact.id }, data: { avatarUrl: '' } }).catch(() => {});
            noPicture += 1;
            consecutiveErrors = 0;
          } else {
            consecutiveErrors += 1;
            if (consecutiveErrors >= 5) {
              console.warn(`[whatsapp] ${organizationId}: demasiados errores al descargar avatares (${message}); se detiene`);
              return { started: true, fetched, noPicture, stopped: true };
            }
            await new Promise((resolve) => setTimeout(resolve, 15000));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, AVATAR_BACKFILL_DELAY_MS));
      }
    }
    console.log(`[whatsapp] avatares de contactos para ${organizationId}: ${fetched} descargados, ${noPicture} sin foto`);
    return { started: true, fetched, noPicture };
  } catch (err) {
    console.error('[whatsapp] backfill de avatares falló:', err.message || err);
    return { started: true, fetched, noPicture, error: true };
  } finally {
    avatarBackfills.delete(organizationId);
  }
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
  // Los grupos ya vienen como JID completo (…@g.us): se usan tal cual.
  if (/@g\.us$/.test(String(phone))) return String(phone);
  return String(phone).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}

const groupCache = new Map();

// Grupos de WhatsApp donde participa la cuenta conectada (cache corto para no golpear a WhatsApp).
async function listGroups(organizationId, { force = false } = {}) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    const error = new Error('Conectá WhatsApp para ver tus grupos');
    error.status = 409;
    throw error;
  }
  const cached = groupCache.get(organizationId);
  if (!force && cached && Date.now() - cached.at < 60000) return cached.groups;
  const all = await entry.sock.groupFetchAllParticipating();
  const groups = Object.values(all || {})
    .filter((group) => group && group.id && !group.isCommunityAnnounce)
    .map((group) => ({
      id: group.id,
      name: group.subject || 'Grupo sin nombre',
      size: Array.isArray(group.participants) ? group.participants.length : (group.size || 0),
      announce: Boolean(group.announce),
      // Si el grupo es "solo admins pueden escribir", el envío solo funciona si la cuenta es admin.
      canSend: !group.announce || (group.participants || []).some((p) => p.admin && phoneFromJid(p.id) === phoneFromJid(entry.sock.user && entry.sock.user.id))
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  groupCache.set(organizationId, { at: Date.now(), groups });
  return groups;
}

// Todos los grupos con sus integrantes (para el panel de Grupos). Los LID se traducen a teléfono cuando WhatsApp
// tiene la equivalencia; si no, el integrante queda con el teléfono en null ("por identificar"), NUNCA se inventa uno.
// Fotos de grupos e integrantes: se piden de a poco (mismo ritmo que los avatares de contactos) para no saturar a WhatsApp.
// Reutiliza la foto ya guardada del Contact cuando el integrante coincide con un contacto conocido, así no se pide dos veces.
async function backfillGroupAvatarsWithSock(organizationId, sock, { onProgress, stillConnected = () => true } = {}) {
  let fetched = 0;
  let processed = 0;
  const cache = new Map();
  async function pictureFor(jid) {
    if (cache.has(jid)) return cache.get(jid);
    try {
      const url = await Promise.race([
        sock.profilePictureUrl(jid, 'image'),
        new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 8000); t.unref?.(); })
      ]);
      const key = typeof url === 'string' && /^https?:\/\//i.test(url) ? await downloadAvatarToStorage(organizationId, url) : null;
      const result = key || '';
      cache.set(jid, result);
      return result;
    } catch {
      cache.set(jid, '');
      return '';
    } finally {
      await new Promise((resolve) => setTimeout(resolve, AVATAR_BACKFILL_DELAY_MS));
    }
  }

  const groups = await prisma.whatsappGroup.findMany({ where: { organizationId, avatarUrl: null } });
  for (const group of groups) {
    if (!stillConnected()) return { started: true, fetched, processed, interrupted: true };
    const key = await pictureFor(group.jid);
    if (key) { await prisma.whatsappGroup.update({ where: { id: group.id }, data: { avatarUrl: key } }); fetched += 1; }
    else await prisma.whatsappGroup.update({ where: { id: group.id }, data: { avatarUrl: '' } });
    processed += 1;
    if (onProgress) await onProgress({ processed });
  }

  const members = await prisma.whatsappGroupMember.findMany({ where: { avatarUrl: null, phone: { not: null }, group: { organizationId } } });
  for (const member of members) {
    if (!stillConnected()) return { started: true, fetched, processed, interrupted: true };
    const contact = await prisma.contact.findFirst({ where: { organizationId, phone: member.phone, avatarUrl: { not: null } }, select: { avatarUrl: true } });
    const key = contact && contact.avatarUrl ? contact.avatarUrl : await pictureFor(jidFromPhone(member.phone));
    await prisma.whatsappGroupMember.update({ where: { id: member.id }, data: { avatarUrl: key || '' } });
    if (key) fetched += 1;
    processed += 1;
    if (onProgress) await onProgress({ processed });
  }
  return { started: true, fetched, processed };
}

// Envoltorio que resuelve la sesión activa (usado en producción); backfillGroupAvatarsWithSock queda testeable sin sesión real.
async function backfillGroupAvatars(organizationId, options = {}) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) return { started: false };
  const sock = entry.sock;
  return backfillGroupAvatarsWithSock(organizationId, sock, { ...options, stillConnected: () => { const current = sessions.get(organizationId); return Boolean(current && current.sock === sock && current.status === 'connected'); } });
}

async function fetchGroupsDetailed(organizationId) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    const error = new Error('Conectá WhatsApp para descargar tus grupos');
    error.status = 409;
    throw error;
  }
  const sock = entry.sock;
  const selfPhone = phoneFromJid(sock.user && sock.user.id);
  const all = await sock.groupFetchAllParticipating();
  const raw = Object.values(all || {}).filter((group) => group && group.id && !group.isCommunityAnnounce);
  const groups = [];
  for (const group of raw) {
    const members = [];
    for (const participant of group.participants || []) {
      const original = participant.id;
      const lid = isLidJid(original) ? original : (participant.lid && isLidJid(participant.lid) ? participant.lid : null);
      let phoneJid = participant.phoneNumber || (!isLidJid(original) ? original : null);
      if (!phoneJid && lid) phoneJid = await resolvePhoneJid(sock, lid);
      const digits = phoneFromJid(phoneJid);
      const phone = /^\d{6,15}$/.test(digits || '') ? digits : null;
      members.push({
        jid: original,
        lid,
        phone,
        name: (participant.name || participant.notify || (phone && entry.phoneContacts.get(phone)?.name)) || null,
        role: participant.admin === 'superadmin' ? 'superadmin' : participant.admin ? 'admin' : null,
        isSelf: Boolean(phone && phone === selfPhone)
      });
    }
    const ownerJid = group.owner || group.subjectOwner || null;
    const ownerPhone = ownerJid ? phoneFromJid(await resolvePhoneJid(sock, ownerJid)) : null;
    groups.push({
      jid: group.id,
      name: group.subject || 'Grupo sin nombre',
      description: group.desc || null,
      ownerJid,
      ownerPhone: /^\d{6,15}$/.test(ownerPhone || '') ? ownerPhone : null,
      groupCreatedAt: group.creation ? new Date(Number(group.creation) * 1000) : null,
      announce: Boolean(group.announce),
      members
    });
  }
  return groups;
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
  // La libreta se recuerda en memoria (para poder importarla luego), pero solo se guarda en la base si el usuario lo autorizó.
  const persist = (await require('./whatsappSync').getFlags(organizationId)).syncContactsEnabled;
  for (const contact of contacts) {
    const rawJid = contact && contact.id;
    if (!rawJid || !isRealPersonJid(rawJid)) continue;
    const resolvedJid = await resolvePhoneJid(entry.sock, contact.phoneNumber || rawJid);
    const phone = phoneFromJid(resolvedJid);
    if (!/^\d{6,}$/.test(phone)) continue;
    const previous = entry.phoneContacts.get(phone);
    const name = contact.name || contact.notify || contact.verifiedName || (previous && previous.name) || null;
    entry.phoneContacts.set(phone, { phone, name });
    if (!persist) continue;
    const existing = await prisma.contact.findFirst({ where: { organizationId, OR: [{ phone }, { externalId: rawJid }] } });
    if (!existing) await prisma.contact.create({ data: { organizationId, phone, externalId: rawJid, name, tags: [require('./whatsappSync').IMPORTED_TAG] } });
    else if (((!existing.name || existing.name.replace(/\D/g, '') === phone) && name) || !existing.phone) await prisma.contact.update({ where: { id: existing.id }, data: { phone, ...((!existing.name || existing.name.replace(/\D/g, '') === phone) && name ? { name } : {}) } });
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
  if (callOwnership.has(organizationId)) return Promise.resolve(publicStatus(organizationId));
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

  if (!options.auto) {
    stalledSessions.delete(organizationId);
    consecutiveFailures.delete(organizationId);
    authRejections.delete(organizationId);
  }
  if (relinkRequired.has(organizationId) && !hasStoredSession(organizationId)) relinkRequired.delete(organizationId);
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
    // Solo se pide el historial completo si el usuario autorizó importarlo.
    syncFullHistory: process.env.WHATSAPP_SYNC_FULL_HISTORY !== 'false' && (await require('./whatsappSync').getFlags(organizationId)).syncMessageHistoryEnabled
  };
  // If GitHub is unavailable, Baileys already knows a compatible bundled version.
  if (versionInfo && versionInfo.version) sockOptions.version = versionInfo.version;
  const sock = makeWASocket(sockOptions);
  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messaging-history.set', async (payload) => {
    // Los chats individuales también traen el nombre guardado en la libreta.
    const chatNames = (payload?.chats || []).map((chat) => ({ id: chat.id, name: chat.name }));
    // Sin autorización no se guarda ningún mensaje histórico (los contactos solo quedan en memoria; ver rememberPhoneContacts).
    const allowHistory = (await require('./whatsappSync').getFlags(organizationId)).syncMessageHistoryEnabled;
    enqueueMessages(organizationId, sock, allowHistory ? (payload?.messages || []) : [], true, [...chatNames, ...(payload?.contacts || [])])
      .catch(err => console.error('[whatsapp] history sync failed:', err.message));
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    enqueueMessages(organizationId, sock, [], true, contacts)
      .catch((err) => console.error('[whatsapp] contact mapping failed', err));
  });

  sock.ev.on('contacts.update', (contacts) => {
    enqueueMessages(organizationId, sock, [], true, contacts)
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
      consecutiveFailures.delete(organizationId);
      authRejections.delete(organizationId);
      stalledSessions.delete(organizationId);
      relinkRequired.delete(organizationId);
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
      restoreQrHistory(organizationId, sock).catch(err => console.error('[whatsapp] restore history:', err.message));
      emitStatus(organizationId);
      // Let the history import settle first, then fetch profile pictures in the background.
      // Baja los grupos (con integrantes) una vez que la conexión se asentó.
      setTimeout(async () => { if (await require('./whatsappSync').isEnabled(organizationId, 'groups')) require('./whatsappGroups').syncGroups(organizationId).catch((err) => console.warn('[whatsapp] grupos no sincronizados:', err.message || err)); }, 12000);
      const avatarTimer = setTimeout(async () => { if (await require('./whatsappSync').isEnabled(organizationId, 'avatars')) backfillContactAvatars(organizationId, sock).catch(() => {}); }, 20000);
      avatarTimer.unref?.();
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
      // WhatsApp explains a stream error in the payload (e.g. conflict type="replaced" when another
      // client took the session, or "device_removed" when it was unlinked from the phone).
      let reasonData = '';
      try {
        const data = lastDisconnect?.error?.data;
        if (data) reasonData = `; datos=${JSON.stringify(data, (_k, v) => (v && v.type === 'Buffer' ? '[bin]' : v)).slice(0, 300)}`;
      } catch { /* diagnostic only */ }
      console.warn(`[whatsapp] conexión cerrada para ${organizationId}; código=${statusCode || 'desconocido'}; logout=${loggedOut}; detalle=${disconnectMessage}${reasonData}`);

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

      // WhatsApp says explicitly that this linked device was removed, or keeps rejecting the stored
      // credentials with 401: they are dead. Retrying only hammers the server (and the number), so stop,
      // archive them and ask for a new QR.
      const rejected = statusCode === 401 && /connection failure/i.test(disconnectMessage);
      const rejections = rejected ? (authRejections.get(organizationId) || 0) + 1 : 0;
      if (rejected) authRejections.set(organizationId, rejections);
      const revoked = !loggedOut && (isDeviceRemoved(lastDisconnect?.error) || rejections >= AUTH_REJECT_LIMIT);
      if (revoked) {
        const pendingTimer = reconnectTimers.get(organizationId);
        if (pendingTimer) clearTimeout(pendingTimer);
        reconnectTimers.delete(organizationId);
        reconnectAttempts.delete(organizationId);
        consecutiveFailures.delete(organizationId);
        authRejections.delete(organizationId);
        stalledSessions.delete(organizationId);
        archiveSession(organizationId, 'removed');
        relinkRequired.set(organizationId, RELINK_MESSAGE);
        console.error(`[whatsapp] ${organizationId}: WhatsApp revocó la sesión (${isDeviceRemoved(lastDisconnect?.error) ? 'device_removed' : `${rejections} rechazos 401`}); credenciales archivadas, hace falta un QR nuevo`);
        syncCallAccountState(organizationId, 'DISCONNECTED', null, RELINK_MESSAGE);
        emitToOrg(organizationId, 'whatsapp:status', { status: 'disconnected', qr: null, phone: null, needsRelink: true, lastError: RELINK_MESSAGE });
        return;
      }

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
        const failures = (consecutiveFailures.get(organizationId) || 0) + 1;
        consecutiveFailures.set(organizationId, failures);
        if (failures >= MAX_CONSECUTIVE_RECONNECT_FAILURES) {
          const pending = reconnectTimers.get(organizationId);
          if (pending) clearTimeout(pending);
          reconnectTimers.delete(organizationId);
          reconnectAttempts.delete(organizationId);
          stalledSessions.add(organizationId);
          console.error(`[whatsapp] ${organizationId}: ${failures} fallos consecutivos; se detiene la reconexión automática (credenciales conservadas)`);
          syncCallAccountState(organizationId, 'DISCONNECTED', null, disconnectMessage);
          emitToOrg(organizationId, 'whatsapp:status', { status: 'disconnected', qr: null, phone: null, needsManualReconnect: true, lastError: disconnectMessage });
          return;
        }
        syncCallAccountState(organizationId, 'RECONNECTING', null, disconnectMessage);
        emitToOrg(organizationId, 'whatsapp:status', { status: 'connecting', qr: null, phone: null, avatarUrl: entry.avatarUrl || sessionAvatars.get(organizationId) || null, lastError: disconnectMessage });
        scheduleReconnect(organizationId);
      }
    }
  });

  sock.ev.on('messages.upsert', (payload) => {
    // Estados (status@broadcast) are stories, not conversations: route them to their own store.
    const statusMessages = [];
    const chatMessages = [];
    for (const message of payload.messages || []) {
      (whatsappStatus.isStatusBroadcast(message?.key?.remoteJid) ? statusMessages : chatMessages).push(message);
    }
    for (const message of statusMessages) {
      // Los estados de otras personas solo se guardan si el usuario lo autorizó (los propios se registran siempre).
      const allowed = message?.key?.fromMe ? Promise.resolve(true) : require('./whatsappSync').isEnabled(organizationId, 'statuses');
      allowed.then((ok) => ok && whatsappStatus.handleStatusMessage(organizationId, sock, message, statusHelpers))
        .catch((err) => console.error('[whatsapp] status sync failed:', err.message || err));
    }
    if (chatMessages.length === 0 && statusMessages.length > 0) return;
    // Baileys marca type 'append' tanto para el historial como para mensajes EN VIVO que llegan mientras
    // la sesión se sincroniza. Tratarlos todos como historial hacía que el bot no respondiera justo a esos
    // (p. ej. el cliente elegía "1" del menú y no pasaba nada). Se decide por la fecha del mensaje.
    const live = [];
    const history = [];
    for (const message of chatMessages) ((payload.type === 'notify' || isRecentMessage(message)) ? live : history).push(message);
    if (live.length > 0) {
      enqueueMessages(organizationId, sock, live, false)
        .catch(err => console.error('[whatsapp] message sync failed:', err.message));
    }
    if (history.length > 0) {
      enqueueMessages(organizationId, sock, history, true)
        .catch(err => console.error('[whatsapp] message sync failed:', err.message));
    }
  });

  sock.ev.on('messages.reaction', (reactions) => {
    for (const item of reactions) {
      handleInboundReaction(organizationId, sock, item).catch((err) => console.error('[whatsapp] inbound reaction error', err));
    }
  });

  // Cada persona que abre un estado nuestro genera un recibo de lectura sobre status@broadcast.
  sock.ev.on('message-receipt.update', (updates) => {
    for (const update of updates || []) {
      const key = update && update.key;
      const receipt = update && update.receipt;
      if (!key || !key.id || !whatsappStatus.isStatusBroadcast(key.remoteJid) || !key.fromMe || !receipt || !receipt.userJid) continue;
      const seenAt = receipt.readTimestamp || receipt.playedTimestamp;
      if (!seenAt) continue; // solo "entregado": todavía no lo abrió
      handleOwnStatusView(organizationId, sock, { waMessageId: key.id, userJid: receipt.userJid, seenAt }).catch((err) => console.error('[whatsapp] status view error', err));
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
  callOwnership.add(organizationId);
  const pendingTimer = reconnectTimers.get(organizationId);
  if (pendingTimer) clearTimeout(pendingTimer);
  reconnectTimers.delete(organizationId);

  const entry = sessions.get(organizationId);
  if (!entry || !entry.sock) { callOwnership.delete(organizationId); return false; }
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
  callOwnership.delete(organizationId);
  if (!hasStoredSession(organizationId)) return publicStatus(organizationId);
  const current = sessions.get(organizationId);
  if (current && ['connecting', 'qr', 'connected'].includes(current.status)) return publicStatus(organizationId);
  await connect(organizationId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const status = publicStatus(organizationId);
    if (status.status === 'connected') return status;
    if (status.status === 'qr') throw new Error('WhatsApp requiere vinculación');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('WhatsApp todavía se está reconectando');
}

// Called once at server boot: every org that has a previously-linked session (a creds.json
// left on disk by useMultiFileAuthState) gets reconnected automatically, so a server restart
// doesn't force re-scanning a QR code for a number that's already paired.
async function resumeSessions() {
  if (!fs.existsSync(SESSION_ROOT)) return;
  const entries = fs.readdirSync(SESSION_ROOT, { withFileTypes: true });
  const inactive = new Set((await prisma.organization.findMany({ where: { active: false }, select: { id: true } })).map((org) => org.id));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (inactive.has(entry.name)) {
      console.warn(`[whatsapp] se omite la organización suspendida ${entry.name}`);
      continue;
    }
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

// A QR login (login page) linked this number again while the organisation's own session was dead or
// reconnecting. The fresh pairing replaces the old credentials instead of being thrown away.
async function adoptSession(organizationId, takeFn) {
  const pendingTimer = reconnectTimers.get(organizationId);
  if (pendingTimer) clearTimeout(pendingTimer);
  reconnectTimers.delete(organizationId);
  reconnectAttempts.delete(organizationId);
  consecutiveFailures.delete(organizationId);
  authRejections.delete(organizationId);
  stalledSessions.delete(organizationId);
  relinkRequired.delete(organizationId);
  const entry = sessions.get(organizationId);
  if (entry) {
    entry.pausedForCall = true; // makes the close handler a no-op instead of scheduling a reconnect
    try { if (entry.sock && typeof entry.sock.end === 'function') entry.sock.end(undefined); } catch { /* already closed */ }
    sessions.delete(organizationId);
  }
  archiveSession(organizationId, 'replaced');
  return takeFn(sessionDir(organizationId));
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
  relinkRequired.delete(organizationId);
  authRejections.delete(organizationId);
  emitToOrg(organizationId, 'whatsapp:status', { status: 'disconnected', qr: null, phone: null, lastError: null });
}

// Suspending an organization must stop its WhatsApp transport (bot replies, campaigns, calls)
// without unlinking the phone: credentials stay on disk so reactivation resumes seamlessly.
async function suspendSession(organizationId) {
  const pending = reconnectTimers.get(organizationId);
  if (pending) clearTimeout(pending);
  reconnectTimers.delete(organizationId);
  reconnectAttempts.delete(organizationId);
  consecutiveFailures.delete(organizationId);
  stalledSessions.add(organizationId);
  const entry = sessions.get(organizationId);
  if (!entry) return;
  entry.pausedForCall = true; // makes the close handler a no-op instead of scheduling a reconnect
  try { if (entry.sock) await entry.sock.end(); } catch (err) { console.warn('[whatsapp] suspend:', err.message || err); }
  if (sessions.get(organizationId) === entry) sessions.delete(organizationId);
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

async function syncContacts(organizationId, { onProgress } = {}) {
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
  let processed = 0;
  const total = entry.phoneContacts.size;
  if (onProgress) await onProgress({ total, processed });
  for (const candidate of entry.phoneContacts.values()) {
    processed += 1;
    if (onProgress && processed % 25 === 0) await onProgress({ total, processed });
    const existing = await prisma.contact.findFirst({ where: { organizationId, phone: candidate.phone } });
    if (existing) {
      const nameIsBlank = !existing.name || existing.name.replace(/\D/g, '') === candidate.phone;
      if (nameIsBlank && candidate.name) {
        await prisma.contact.update({ where: { id: existing.id }, data: { name: candidate.name } });
        updated += 1;
      }
      continue;
    }
    await prisma.contact.create({ data: { organizationId, phone: candidate.phone, name: candidate.name, tags: [require('./whatsappSync').IMPORTED_TAG] } });
    imported += 1;
  }
  return { imported, updated, total: entry.phoneContacts.size };
}

const whatsappStatus = require('./whatsappStatus');
const statusHelpers = {
  extractMedia: (m) => extractMedia(m),
  extractText: (m) => extractText(m),
  downloadInboundMedia: (s, m, media) => downloadInboundMedia(s, m, media),
  resolvePhoneJid: (s, jid) => resolvePhoneJid(s, jid),
  phoneFromJid: (jid) => phoneFromJid(jid)
};

// Un mensaje "en vivo" es el que acaba de llegar; el historial que manda WhatsApp al sincronizar es más viejo.
const LIVE_MESSAGE_WINDOW_MS = 5 * 60 * 1000;
function isRecentMessage(message, now = Date.now()) {
  const raw = message && message.messageTimestamp;
  const seconds = Number(raw && typeof raw === 'object' && 'toNumber' in raw ? raw.toNumber() : raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return true; // sin fecha: se asume en vivo
  return now - seconds * 1000 <= LIVE_MESSAGE_WINDOW_MS;
}

function enqueueMessages(organizationId, sock, messages, historical = false, contacts = []) {
  const previous = messageQueues.get(organizationId) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await rememberPhoneContacts(organizationId, contacts);
    for (const message of messages) await handleInboundMessage(organizationId, sock, message, { historical });
    if (historical && messages.length && (await require('./whatsappSync').isEnabled(organizationId, 'message_history'))) {
      console.log(`[whatsapp] historial procesado: ${messages.length} mensajes para ${organizationId}`);
      await require('./whatsappSync').noteHistoryBatch(organizationId, messages.length).catch(() => {});
    }
  });
  messageQueues.set(organizationId, next);
  next.finally(() => { if (messageQueues.get(organizationId) === next) messageQueues.delete(organizationId); }).catch(() => {});
  return next;
}

async function restoreQrHistory(organizationId, sock) {
  const file = path.join(sessionDir(organizationId), '.niro-history.jsonl');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const payload = JSON.parse(line);
    await enqueueMessages(organizationId, sock, payload.messages || [], true, payload.contacts);
  }
  fs.unlinkSync(file);
}

async function handleInboundMessage(organizationId, sock, waMessage, { historical = false } = {}) {
  if (!waMessage?.key) return;
  // Historial anterior del teléfono: solo con autorización expresa del usuario (los mensajes nuevos funcionan siempre).
  if (historical && !(await require('./whatsappSync').isEnabled(organizationId, 'message_history'))) return;
  const fromMe = Boolean(waMessage.key.fromMe);
  const rawJid = waMessage.key.remoteJid;
  if (!rawJid || !isRealPersonJid(rawJid)) return;

  const media = extractMedia(waMessage);
  const caption = extractText(waMessage);
  if (!caption && !media) return;

  const resolvedJid = await resolvePhoneJid(sock, waMessage.key.remoteJidAlt || rawJid);
  const phone = phoneFromJid(resolvedJid);
  const rawUser = jidUser(rawJid);
  const quoted = extractQuoted(waMessage);

  let surveyHandled = false;
  if (phone && !historical && !fromMe) {
    const surveyResult = await registerInboundResponse(organizationId, phone, caption).catch((err) => {
      console.error('[whatsapp] survey response error', err);
      return null;
    });
    surveyHandled = Boolean(surveyResult);
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
        name: (fromMe ? null : waMessage.pushName) || sessions.get(organizationId)?.phoneContacts.get(phone)?.name || null
      }
    });
  } else if (phone && (contact.phone !== phone || contact.externalId !== rawJid)) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: { phone, externalId: rawJid }
    });
  }
  if (!historical && (await require('./whatsappSync').isEnabled(organizationId, 'avatars'))) contact = await ensureContactAvatar(sock, contact, resolvedJid || rawJid);

  // Un solo chat por contacto, como WhatsApp: si el anterior estaba cerrado se reabre (no se crea otro en la lista).
  let conversation = await prisma.conversation.findFirst({
    where: { organizationId: organizationId, contactId: contact.id, channel: 'whatsapp' },
    orderBy: { updatedAt: 'desc' },
    include: CONVERSATION_INCLUDE
  });

  const isNewConversation = !conversation;
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { organizationId: organizationId, contactId: contact.id, channel: 'whatsapp' },
      include: CONVERSATION_INCLUDE
    });
  } else if (!historical && conversation.status === 'CLOSED') {
    // Vuelve a abrirse con el mensaje nuevo. Se quita "Derivado" para que el bot pueda volver a atender
    // si nadie lo tiene asignado; si un agente lo tenía, sigue siendo suyo.
    const tags = Array.isArray(conversation.tags) ? conversation.tags.filter((tag) => tag !== HANDOFF_TAG) : [];
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: 'OPEN', ...(conversation.assignedToId ? {} : { tags }) },
      include: CONVERSATION_INCLUDE
    });
    emitToOrg(organizationId, 'conversation:updated', { conversation: sanitizeConversation(conversation) });
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
  if (media && !historical) {
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

  const timestamp = waMessage.messageTimestamp;
  const seconds = typeof timestamp === 'object' && timestamp !== null && 'low' in timestamp ? (timestamp.high || 0) * 4294967296 + (timestamp.low >>> 0) : Number(timestamp || 0);
  const messageDate = historical && seconds > 0 && seconds < Date.now() / 1000 + 86400 ? new Date(seconds * 1000) : new Date();
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderUserId: null,
      ...(fromMe ? { senderKind: 'phone' } : {}),
      direction: fromMe ? 'OUTBOUND' : 'INBOUND',
      createdAt: messageDate,
      content: content.slice(0, 4000),
      contentType,
      waMessageId: waMessage.key.id || null,
      imported: historical,
      quotedMessageId: null,
      quotedPreview: quoted ? quoted.preview : null,
      quotedSender: quoted ? quoted.sender : null,
      ...(attachmentCreate ? { attachment: attachmentCreate } : {})
    },
    include: MESSAGE_INCLUDE
  });

  let updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: historical && !isNewConversation ? new Date(Math.max(new Date(conversation.updatedAt).getTime(), messageDate.getTime())) : messageDate },
    include: CONVERSATION_INCLUDE
  });

  broadcastMessage(organizationId, conversation.id, message);
  emitToOrg(organizationId, isNewConversation ? 'conversation:new' : 'conversation:updated', {
    conversation: sanitizeConversation(updated)
  });

  // Audio recibido + opción activa en Configuración → se transcribe en segundo plano y el texto aparece bajo el audio.
  if (!historical && !fromMe && media && media.kind === 'audio' && mediaBuffer && message.attachment) {
    require('./aiMedia').autoTranscribeIfEnabled({
      organizationId, conversationId: conversation.id, messageId: message.id, buffer: mediaBuffer, fileName: media.fileName, mimeType: media.mimeType
    }).catch(() => {});
  }

  // Si el cliente contestó la encuesta de una llamada, ya se le respondió: el bot/IA no debe volver a contestarle.
  if (historical || fromMe || surveyHandled) return;
  // Plan vencido: el mensaje queda guardado, pero el bot y la IA dejan de responder.
  if (await require('./billing').isBlocked(organizationId).catch(() => false)) return;

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

  // Un solo motor para el primer mensaje y los siguientes (ver lib/botRunner.js).
  await require('./botRunner').handleBotTurn({
    organizationId,
    conversation: updated,
    contact,
    content: caption,
    isNewConversation,
    settings,
    organizationName,
    deliver: phone ? (text) => sendText(organizationId, phone, text) : null
  });
}

// Vista de un estado propio: resuelve quién es (los LID se traducen a teléfono cuando se puede) y la registra.
async function handleOwnStatusView(organizationId, sock, { waMessageId, userJid, seenAt }) {
  const phone = phoneFromJid(await resolvePhoneJid(sock, userJid));
  const seconds = Number(seenAt && typeof seenAt === 'object' && 'toNumber' in seenAt ? seenAt.toNumber() : seenAt);
  await require('./statusViews').recordStatusActivity(organizationId, {
    waMessageId, viewerJid: userJid, phone, viewedAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date()
  });
}

// "Me gusta" (reacción con emoji) de alguien a un estado propio. Quitar la reacción llega con el texto vacío.
async function handleOwnStatusReaction(organizationId, sock, item) {
  const reactionKey = item.reaction && item.reaction.key ? item.reaction.key : {};
  const viewerJid = reactionKey.participant || reactionKey.participantAlt || (reactionKey.remoteJid && !whatsappStatus.isStatusBroadcast(reactionKey.remoteJid) ? reactionKey.remoteJid : null);
  if (!viewerJid || !item.key.id) return;
  const phone = phoneFromJid(await resolvePhoneJid(sock, viewerJid));
  const emoji = item.reaction && item.reaction.text ? item.reaction.text : null;
  const seconds = Number(item.reaction && item.reaction.senderTimestampMs ? Number(item.reaction.senderTimestampMs) / 1000 : 0);
  await require('./statusViews').recordStatusActivity(organizationId, {
    waMessageId: item.key.id, viewerJid, phone, hasReaction: true, reaction: emoji, reactedAt: seconds > 0 ? new Date(seconds * 1000) : new Date()
  });
}

async function handleInboundReaction(organizationId, sock, item) {
  if (item.key && whatsappStatus.isStatusBroadcast(item.key.remoteJid)) {
    if (item.key.fromMe) await handleOwnStatusReaction(organizationId, sock, item);
    return;
  }
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

// Publishing a WhatsApp "estado" (story) goes to status@broadcast with an explicit audience.
// The session's own number is always included so the status also shows on the phone.
function statusRecipients(entry, jids) {
  const own = phoneFromJid(entry.sock.user && entry.sock.user.id);
  const list = new Set(jids);
  if (own) list.add(jidFromPhone(own));
  return [...list];
}

async function sendStatusBroadcast(organizationId, content, options = {}, jids = []) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    throw new Error('WhatsApp no esta conectado para esta organizacion');
  }
  const sent = await entry.sock.sendMessage('status@broadcast', content, {
    ...options,
    broadcast: true,
    statusJidList: statusRecipients(entry, jids)
  });
  return sent && sent.key ? sent.key.id : null;
}

async function deleteStatusBroadcast(organizationId, waMessageId, jids = []) {
  const entry = sessions.get(organizationId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    throw new Error('WhatsApp no esta conectado para esta organizacion');
  }
  const own = entry.sock.user && entry.sock.user.id;
  await entry.sock.sendMessage(
    'status@broadcast',
    { delete: { remoteJid: 'status@broadcast', fromMe: true, id: waMessageId, participant: own } },
    { broadcast: true, statusJidList: statusRecipients(entry, jids) }
  );
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
  adoptSession: adoptSession,
  disconnect: disconnect,
  shutdown: shutdown,
  suspendSession: suspendSession,
  hasStoredSession: hasStoredSession,
  pauseForCall: pauseForCall,
  resumeAfterCall: resumeAfterCall,
  resumeSessions: resumeSessions,
  getStatus: publicStatus,
  listSessions: listSessions,
  syncContacts: syncContacts,
  fetchGroupsDetailed: fetchGroupsDetailed,
  backfillGroupAvatars: backfillGroupAvatars,
  backfillGroupAvatarsWithSock: backfillGroupAvatarsWithSock,
  listGroups: listGroups,
  backfillAvatars: (organizationId, options) => { const entry = sessions.get(organizationId); return entry && entry.sock ? backfillContactAvatars(organizationId, entry.sock, options) : Promise.resolve({ started: false }); },
  ingestMessages: enqueueMessages,
  isRecentMessage,
  getSessionReference: (organizationId) => sessionDir(organizationId),
  sendText: sendText,
  sendMedia: sendMedia,
  sendStatusBroadcast: sendStatusBroadcast,
  deleteStatusBroadcast: deleteStatusBroadcast,
  sendReaction: sendReaction,
  deleteMessage: deleteMessage,
  sendPoll: sendPoll,
  sendContactCard: sendContactCard,
  isRealPersonJid: isRealPersonJid,
  phoneFromJid: phoneFromJid,
  resolvePhoneJid: resolvePhoneJid
};
