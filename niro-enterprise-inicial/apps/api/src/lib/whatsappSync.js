// Centro de sincronización con WhatsApp: qué se importa desde el teléfono lo decide el usuario, opción por opción.
// Todo está apagado por defecto. Con una opción apagada el servidor NO guarda ese tipo de datos (no basta con ocultarlos).
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');
const { audit } = require('./audit');

const TYPES = ['groups', 'contacts', 'message_history', 'avatars', 'statuses'];
const FLAG = { groups: 'syncGroupsEnabled', contacts: 'syncContactsEnabled', message_history: 'syncMessageHistoryEnabled', avatars: 'syncAvatarsEnabled', statuses: 'syncStatusesEnabled' };
const IMPORTED_TAG = 'Contacto importado';
const ACTIVE = ['PENDING', 'PROCESSING'];

const NONE = { syncGroupsEnabled: false, syncContactsEnabled: false, syncMessageHistoryEnabled: false, syncAvatarsEnabled: false, syncStatusesEnabled: false };
const flagCache = new Map();

async function getFlags(organizationId) {
  const cached = flagCache.get(organizationId);
  if (cached && Date.now() - cached.at < 10000) return cached.flags;
  const row = await prisma.organizationSettings.findUnique({ where: { organizationId }, select: Object.fromEntries(Object.values(FLAG).map((f) => [f, true])) });
  const flags = row ? { ...NONE, ...row } : { ...NONE };
  flagCache.set(organizationId, { at: Date.now(), flags });
  return flags;
}
function invalidateFlags(organizationId) { flagCache.delete(organizationId); }
async function isEnabled(organizationId, type) { return Boolean((await getFlags(organizationId))[FLAG[type]]); }

function sanitizeJob(job) {
  if (!job) return null;
  return { id: job.id, type: job.type, status: job.status, total: job.total, processed: job.processed, failed: job.failed, message: job.message, detail: job.detail, startedAt: job.startedAt, finishedAt: job.finishedAt };
}

async function activeJob(organizationId, type) {
  return prisma.whatsappSyncJob.findFirst({ where: { organizationId, type, status: { in: ACTIVE } }, orderBy: { startedAt: 'desc' } });
}

async function createJob(organizationId, type, userId) {
  const job = await prisma.whatsappSyncJob.create({ data: { organizationId, type, status: 'PROCESSING', requestedByUserId: userId || null } });
  emitToOrg(organizationId, 'sync:job', { job: sanitizeJob(job) });
  return job;
}

const lastEmit = new Map();
async function progress(job, patch, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - (lastEmit.get(job.id) || 0) < 700) { Object.assign(job, patch); return job; }
  lastEmit.set(job.id, now);
  const updated = await prisma.whatsappSyncJob.update({ where: { id: job.id }, data: patch });
  emitToOrg(job.organizationId, 'sync:job', { job: sanitizeJob(updated) });
  return Object.assign(job, updated);
}

async function finish(job, status, message, patch = {}) {
  lastEmit.delete(job.id);
  const updated = await prisma.whatsappSyncJob.update({ where: { id: job.id }, data: { ...patch, status, message, finishedAt: new Date() } });
  emitToOrg(job.organizationId, 'sync:job', { job: sanitizeJob(updated) });
  await audit(prisma, { organizationId: job.organizationId, actorUserId: job.requestedByUserId, action: 'whatsapp_sync.finished', entityType: 'WhatsappSyncJob', entityId: job.id, metadata: { type: job.type, status, processed: updated.processed, failed: updated.failed, message } }).catch(() => {});
  return updated;
}

const fmt = (n) => Number(n || 0).toLocaleString('es-PY');

// Corre la descarga en segundo plano: devuelve el trabajo enseguida y el progreso llega por Socket.IO (`sync:job`).
async function startJob(organizationId, type, userId) {
  if (!TYPES.includes(type)) { const e = new Error('Tipo de sincronización inválido'); e.status = 400; throw e; }
  if (!(await isEnabled(organizationId, type))) { const e = new Error('Primero activá esta opción para autorizar la descarga.'); e.status = 403; throw e; }
  if (type === 'message_history') { const e = new Error('WhatsApp entrega el historial únicamente al vincular el dispositivo. Con la opción activa, volvé a vincular el número (escaneando el QR) y Niro importará lo que WhatsApp envíe.'); e.status = 409; throw e; }
  if (type === 'statuses') { const e = new Error('Los estados se guardan automáticamente mientras la opción esté activa y WhatsApp los entregue.'); e.status = 409; throw e; }
  const running = await activeJob(organizationId, type);
  if (running) return running;
  const whatsapp = require('./whatsapp');
  const status = whatsapp.getStatus(organizationId);
  if (!status || status.status !== 'connected') { const e = new Error('Conectá WhatsApp para descargar la información.'); e.status = 409; throw e; }

  const job = await createJob(organizationId, type, userId);
  (async () => {
    try {
      if (type === 'groups') {
        const result = await require('./whatsappGroups').syncGroups(organizationId, {
          onProgress: ({ total, processed }) => progress(job, { total, processed })
        });
        if (result.skipped) return finish(job, 'ERROR', 'Ya había una descarga de grupos en curso.');
        await finish(job, 'COMPLETED', `Importación completada: ${fmt(result.groups)} grupos y ${fmt(result.members)} participantes procesados.`, { total: result.groups, processed: result.groups, detail: { groups: result.groups, members: result.members } });
      } else if (type === 'contacts') {
        const result = await whatsapp.syncContacts(organizationId, { onProgress: ({ total, processed }) => progress(job, { total, processed }) });
        await finish(job, 'COMPLETED', `Importación completada: ${fmt(result.imported)} contactos nuevos y ${fmt(result.updated)} actualizados de ${fmt(result.total)} recibidos.`, { total: result.total, processed: result.total, detail: result });
      } else if (type === 'avatars') {
        const [pendingContacts, pendingGroups, pendingMembers] = await Promise.all([
          prisma.contact.count({ where: { organizationId, avatarUrl: null, OR: [{ phone: { not: null } }, { externalId: { not: null } }] } }),
          prisma.whatsappGroup.count({ where: { organizationId, avatarUrl: null } }),
          prisma.whatsappGroupMember.count({ where: { avatarUrl: null, phone: { not: null }, group: { organizationId } } })
        ]);
        await progress(job, { total: pendingContacts + pendingGroups + pendingMembers }, { force: true });
        const contactsResult = await whatsapp.backfillAvatars(organizationId, { onProgress: ({ processed }) => progress(job, { processed }) });
        const groupsResult = await whatsapp.backfillGroupAvatars(organizationId, { onProgress: ({ processed }) => progress(job, { processed: (contactsResult.fetched || 0) + (contactsResult.noPicture || 0) + processed }) });
        const fetched = (contactsResult.fetched || 0) + (groupsResult.fetched || 0);
        const done = (contactsResult.fetched || 0) + (contactsResult.noPicture || 0) + (groupsResult.processed || 0);
        const partial = contactsResult.stopped || contactsResult.interrupted || contactsResult.error || groupsResult.interrupted;
        await finish(job, partial ? 'PARTIAL' : 'COMPLETED', `${partial ? 'Descarga parcial' : 'Descarga completada'}: ${fmt(fetched)} fotos descargadas (contactos, grupos e integrantes) de ${fmt(pendingContacts + pendingGroups + pendingMembers)} pendientes. Podés reintentar sin duplicar.`, { processed: done, detail: { contactsResult, groupsResult } });
      }
    } catch (err) {
      console.error('[sync] falló', type, err.message || err);
      await finish(job, 'ERROR', `La sincronización no pudo completarse (${err.message || 'error'}). Podés reintentar sin duplicar los datos ya descargados.`, { failed: job.failed || 1 }).catch(() => {});
    }
  })();
  return job;
}

// Historial que WhatsApp entrega solo (al vincular): se cuenta en un trabajo que se cierra cuando deja de llegar.
const historyTimers = new Map();
async function noteHistoryBatch(organizationId, count) {
  if (!count) return;
  let job = await activeJob(organizationId, 'message_history');
  if (!job) job = await createJob(organizationId, 'message_history', null);
  await progress(job, { processed: (job.processed || 0) + count, total: (job.total || 0) + count });
  clearTimeout(historyTimers.get(organizationId));
  const timer = setTimeout(() => {
    historyTimers.delete(organizationId);
    finish(job, 'PARTIAL', `Historial recibido: ${fmt(job.processed)} mensajes. WhatsApp entrega solo la parte que tenga disponible para dispositivos vinculados.`).catch(() => {});
  }, 45000);
  timer.unref?.();
  historyTimers.set(organizationId, timer);
}

async function cancelJob(organizationId, type, userId) {
  const job = await activeJob(organizationId, type);
  if (!job) return null;
  return finish({ ...job, requestedByUserId: userId }, 'CANCELLED', 'Sincronización cancelada.');
}

async function getState(organizationId) {
  const flags = await getFlags(organizationId);
  const whatsapp = require('./whatsapp');
  const status = whatsapp.getStatus(organizationId);
  const [groups, contacts, messages, avatars, statuses, jobs] = await Promise.all([
    prisma.whatsappGroup.count({ where: { organizationId } }),
    prisma.contact.count({ where: { organizationId, tags: { has: IMPORTED_TAG } } }),
    prisma.message.count({ where: { imported: true, conversation: { organizationId } } }),
    prisma.contact.count({ where: { organizationId, avatarUrl: { not: null }, NOT: { avatarUrl: '' } } }),
    prisma.whatsappStatus.count({ where: { organizationId, fromMe: false } }),
    Promise.all(TYPES.map((type) => prisma.whatsappSyncJob.findFirst({ where: { organizationId, type }, orderBy: { startedAt: 'desc' } })))
  ]);
  const counts = { groups, contacts, message_history: messages, avatars, statuses };
  return {
    connected: Boolean(status && status.status === 'connected'),
    items: TYPES.map((type, i) => ({ type, enabled: Boolean(flags[FLAG[type]]), stored: counts[type], job: sanitizeJob(jobs[i]) }))
  };
}

async function updateSettings(organizationId, userId, changes, ip) {
  const data = {};
  for (const type of TYPES) if (typeof changes[type] === 'boolean') data[FLAG[type]] = changes[type];
  if (Object.keys(data).length === 0) return getState(organizationId);
  await prisma.organizationSettings.update({ where: { organizationId }, data });
  invalidateFlags(organizationId);
  for (const [type, enabled] of Object.entries(changes)) {
    if (typeof enabled !== 'boolean' || !TYPES.includes(type)) continue;
    const phone = require('./whatsapp').getStatus(organizationId)?.phone || null;
    await audit(prisma, { organizationId, actorUserId: userId, action: enabled ? 'whatsapp_sync.enabled' : 'whatsapp_sync.disabled', entityType: 'OrganizationSettings', entityId: organizationId, metadata: { type, whatsappNumber: phone, ip: ip || null } });
    if (!enabled) await cancelJob(organizationId, type, userId);
  }
  return getState(organizationId);
}

// Borra SOLO lo que Niro importó (nada del teléfono ni de WhatsApp).
async function deleteImported(organizationId, type, userId) {
  let removed = 0;
  if (type === 'groups') {
    removed = (await prisma.whatsappGroup.deleteMany({ where: { organizationId } })).count;
  } else if (type === 'contacts') {
    removed = (await prisma.contact.deleteMany({ where: { organizationId, tags: { has: IMPORTED_TAG }, conversations: { none: {} }, orders: { none: {} } } })).count;
  } else if (type === 'message_history') {
    removed = (await prisma.message.deleteMany({ where: { imported: true, conversation: { organizationId } } })).count;
    await prisma.conversation.deleteMany({ where: { organizationId, channel: 'whatsapp', messages: { none: {} }, assignedToId: null } });
  } else if (type === 'avatars') {
    removed = (await prisma.contact.updateMany({ where: { organizationId, avatarUrl: { not: null } }, data: { avatarUrl: null } })).count;
    removed += (await prisma.whatsappGroup.updateMany({ where: { organizationId, avatarUrl: { not: null } }, data: { avatarUrl: null } })).count;
    removed += (await prisma.whatsappGroupMember.updateMany({ where: { group: { organizationId }, avatarUrl: { not: null } }, data: { avatarUrl: null } })).count;
  } else if (type === 'statuses') {
    const rows = await prisma.whatsappStatus.findMany({ where: { organizationId, fromMe: false }, select: { id: true, storageKey: true } });
    const { deleteFile } = require('./storage');
    for (const row of rows) if (row.storageKey) await deleteFile(row.storageKey).catch(() => {});
    removed = (await prisma.whatsappStatus.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })).count;
  } else { const e = new Error('Tipo inválido'); e.status = 400; throw e; }
  await audit(prisma, { organizationId, actorUserId: userId, action: 'whatsapp_sync.data_deleted', entityType: 'OrganizationSettings', entityId: organizationId, metadata: { type, removed } });
  return removed;
}

module.exports = { TYPES, FLAG, IMPORTED_TAG, getFlags, invalidateFlags, isEnabled, startJob, cancelJob, noteHistoryBatch, getState, updateSettings, deleteImported, sanitizeJob };
