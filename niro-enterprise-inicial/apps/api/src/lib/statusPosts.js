// Publishing WhatsApp "estados" from Nirobot. The queue lives in PostgreSQL: a post is claimed
// atomically (scheduled -> processing) so a restart or a second worker can never publish it twice.
const fsp = require('fs/promises');
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');
const { saveFile, resolvePath, deleteFile } = require('./storage');
const { extensionFor } = require('./attachments');

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [1, 5, 15].map((minutes) => minutes * 60 * 1000);
const STUCK_AFTER_MS = 5 * 60 * 1000;
const MAX_AUDIENCE = Math.max(1, Number(process.env.STATUS_MAX_AUDIENCE || 2000));
const NOT_CONNECTED = /no esta conectado/i;

class StatusPostError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

function whatsapp() {
  return require('./whatsapp');
}

function sanitizePost(post) {
  return {
    id: post.id,
    campaignId: post.campaignId || null,
    sequence: post.sequence ?? null,
    contentType: post.contentType,
    textContent: post.textContent,
    caption: post.caption,
    mediaUrl: post.mediaStorageKey ? `/api/org/status-posts/${post.id}/media` : null,
    backgroundColor: post.backgroundColor,
    fontStyle: post.fontStyle,
    audienceType: post.audienceType,
    audienceTags: post.audienceTags,
    audienceCount: post.audienceCount,
    publicationMode: post.publicationMode,
    scheduledAt: post.scheduledAt,
    publishedAt: post.publishedAt,
    expiresAt: post.expiresAt,
    status: post.status,
    errorMessage: post.errorMessage,
    retryCount: post.retryCount,
    createdAt: post.createdAt,
    attempts: post.attempts ? post.attempts.map((a) => ({ attemptNumber: a.attemptNumber, startedAt: a.startedAt, successful: a.successful, errorMessage: a.errorMessage })) : undefined
  };
}

async function emitPost(post) {
  emitToOrg(post.organizationId, 'status-post:updated', { post: sanitizePost(post) });
}

// Audience -> normalised WhatsApp JIDs. Contacts known only by a LID (no phone) cannot be
// addressed, and groups/invalid numbers are never included.
async function resolveAudience(organizationId, { audienceType, audienceTags = [], audienceContactIds = [] }) {
  const where = { organizationId, phone: { not: null } };
  if (audienceType === 'TAG') {
    if (!audienceTags.length) return { jids: [], count: 0 };
    where.tags = { hasSome: audienceTags };
  } else if (audienceType === 'CUSTOM') {
    if (!audienceContactIds.length) return { jids: [], count: 0 };
    where.id = { in: audienceContactIds };
  } else if (audienceType !== 'ALL') {
    return { jids: [], count: 0 };
  }
  const contacts = await prisma.contact.findMany({ where, select: { phone: true } });
  const jids = new Set();
  for (const contact of contacts) {
    const digits = String(contact.phone || '').replace(/[^0-9]/g, '');
    if (/^\d{7,15}$/.test(digits)) jids.add(`${digits}@s.whatsapp.net`);
  }
  return { jids: [...jids], count: jids.size };
}

async function recordFailure(post, attempt, error) {
  const message = String((error && error.message) || error).slice(0, 500);
  await prisma.whatsappStatusAttempt.update({ where: { id: attempt.id }, data: { finishedAt: new Date(), successful: false, errorMessage: message } });
  const retryable = error instanceof StatusPostError ? error.retryable : true;
  const canRetry = retryable && post.retryCount < RETRY_DELAYS_MS.length
    && !(post.publicationMode === 'NOW' && NOT_CONNECTED.test(message));
  const updated = await prisma.whatsappStatusPost.update({
    where: { id: post.id },
    data: canRetry
      ? { status: 'scheduled', retryCount: post.retryCount + 1, nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[post.retryCount]), errorMessage: message }
      : { status: 'failed', errorMessage: message, nextAttemptAt: null }
  });
  console.warn(`[status-posts] ${post.id} ${canRetry ? 'se reintentará' : 'falló'}: ${message}`);
  await emitPost(updated);
  return updated;
}

// Sends one claimed (status = processing) post.
async function publishClaimed(postId) {
  const post = await prisma.whatsappStatusPost.findUnique({ where: { id: postId } });
  if (!post || post.status !== 'processing') return null;
  const attempt = await prisma.whatsappStatusAttempt.create({ data: { postId: post.id, attemptNumber: post.retryCount + 1 } });
  try {
    if (whatsapp().getStatus(post.organizationId).status !== 'connected') {
      throw new StatusPostError('WhatsApp no esta conectado para esta organizacion', { retryable: true });
    }
    const audience = await resolveAudience(post.organizationId, post);
    if (audience.count === 0) throw new StatusPostError('La audiencia no tiene contactos con un número válido', { retryable: false });
    if (audience.count > MAX_AUDIENCE) throw new StatusPostError(`La audiencia (${audience.count}) supera el máximo de ${MAX_AUDIENCE} contactos; usá una etiqueta o una lista más chica`, { retryable: false });

    let content;
    let options = {};
    if (post.contentType === 'image' || post.contentType === 'video') {
      const isVideo = post.contentType === 'video';
      let buffer;
      try {
        buffer = await fsp.readFile(resolvePath(post.mediaStorageKey));
      } catch {
        throw new StatusPostError(`El archivo ${isVideo ? 'del video' : 'de la imagen'} ya no está disponible`, { retryable: false });
      }
      content = isVideo
        ? { video: buffer, mimetype: post.mimeType || 'video/mp4', ...(post.caption ? { caption: post.caption } : {}) }
        : { image: buffer, mimetype: post.mimeType || 'image/jpeg', ...(post.caption ? { caption: post.caption } : {}) };
    } else {
      content = { text: post.textContent };
      options = { backgroundColor: post.backgroundColor || '#075E54', font: post.fontStyle || 0 };
    }

    const waMessageId = await whatsapp().sendStatusBroadcast(post.organizationId, content, options, audience.jids);
    if (!waMessageId) throw new StatusPostError('WhatsApp no confirmó la publicación', { retryable: true });

    const publishedAt = new Date();
    await prisma.whatsappStatusAttempt.update({ where: { id: attempt.id }, data: { finishedAt: publishedAt, successful: true } });
    const updated = await prisma.whatsappStatusPost.update({
      where: { id: post.id },
      data: { status: 'published', waMessageId, publishedAt, expiresAt: new Date(publishedAt.getTime() + STATUS_TTL_MS), audienceCount: audience.count, errorMessage: null, nextAttemptAt: null }
    });
    await emitPost(updated);
    await retirePrevious(updated);
    return updated;
  } catch (error) {
    return recordFailure(post, attempt, error);
  }
}

// Campaigns with "replacePrevious": once the next item is live, the previous one is withdrawn so
// the audience only ever sees the current status.
async function retirePrevious(post) {
  if (!post.campaignId || post.sequence == null) return;
  try {
    const campaign = await prisma.whatsappStatusCampaign.findUnique({ where: { id: post.campaignId } });
    if (!campaign || !campaign.replacePrevious) return;
    const previous = await prisma.whatsappStatusPost.findMany({ where: { campaignId: post.campaignId, status: 'published', sequence: { lt: post.sequence } } });
    for (const old of previous) await removePost(post.organizationId, old.id);
  } catch (error) {
    console.warn(`[status-posts] no se pudo retirar el estado anterior de la campaña ${post.campaignId}: ${error.message}`);
  }
}

async function claim(postId, fromStatuses = ['scheduled']) {
  const result = await prisma.whatsappStatusPost.updateMany({ where: { id: postId, status: { in: fromStatuses } }, data: { status: 'processing' } });
  return result.count === 1;
}

async function publishNow(postId) {
  if (!(await claim(postId, ['draft', 'scheduled', 'failed']))) return null;
  return publishClaimed(postId);
}

// Worker tick: publish everything that is due. Safe to run from several ticks/instances.
async function runDue() {
  const due = await prisma.whatsappStatusPost.findMany({
    where: { status: 'scheduled', nextAttemptAt: { lte: new Date() }, OR: [{ campaignId: null }, { campaign: { is: { status: 'active' } } }] },
    orderBy: { nextAttemptAt: 'asc' },
    take: 20,
    select: { id: true, organizationId: true }
  });
  let published = 0;
  for (const { id, organizationId } of due) {
    // Plan vencido: los estados programados quedan en espera hasta que se active el plan.
    if (organizationId && await require('./billing').isBlocked(organizationId).catch(() => false)) continue;
    if (await claim(id)) {
      const result = await publishClaimed(id);
      if (result && result.status === 'published') published += 1;
    }
  }
  return { due: due.length, published };
}

// A post left in "processing" by a crash may or may not have been sent. Never resend blindly.
async function recoverStuck() {
  const stuck = await prisma.whatsappStatusPost.findMany({ where: { status: 'processing', updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } } });
  for (const post of stuck) {
    const updated = await prisma.whatsappStatusPost.update({
      where: { id: post.id },
      data: { status: 'failed', errorMessage: 'El servidor se reinició mientras se publicaba. Verificá en WhatsApp si salió y, si no, reintentá.' }
    });
    await emitPost(updated);
  }
  return stuck.length;
}

async function expirePublished() {
  const result = await prisma.whatsappStatusPost.updateMany({ where: { status: 'published', expiresAt: { lte: new Date() } }, data: { status: 'expired' } });
  return result.count;
}

async function tick() {
  await recoverStuck();
  await expirePublished();
  const result = await runDue();
  await require('./statusCampaigns').refreshActive();
  return result;
}

async function removePost(organizationId, id) {
  const post = await prisma.whatsappStatusPost.findFirst({ where: { id, organizationId } });
  if (!post) return null;
  let note = null;
  if (post.status === 'processing') throw new StatusPostError('La publicación se está enviando; esperá unos segundos');
  if (post.status === 'published' && post.waMessageId && post.expiresAt && post.expiresAt > new Date()) {
    try {
      const audience = await resolveAudience(organizationId, post);
      await whatsapp().deleteStatusBroadcast(organizationId, post.waMessageId, audience.jids);
    } catch (error) {
      note = `No se pudo retirar de WhatsApp (${error.message}). Eliminalo desde el teléfono si sigue visible.`;
    }
    const echo = await prisma.whatsappStatus.findFirst({ where: { organizationId, waMessageId: post.waMessageId } });
    if (echo) {
      await prisma.whatsappStatus.delete({ where: { id: echo.id } });
      if (echo.storageKey) await deleteFile(echo.storageKey);
      emitToOrg(organizationId, 'status:deleted', { id: echo.id });
    }
  }
  if (post.mediaStorageKey) await deleteFile(post.mediaStorageKey);
  const updated = await prisma.whatsappStatusPost.update({
    where: { id: post.id },
    data: { status: post.status === 'published' || post.status === 'expired' ? 'deleted' : 'cancelled', mediaStorageKey: null, nextAttemptAt: null, ...(note ? { errorMessage: note } : {}) }
  });
  await emitPost(updated);
  return updated;
}

async function duplicatePost(organizationId, id, userId) {
  const source = await prisma.whatsappStatusPost.findFirst({ where: { id, organizationId } });
  if (!source) return null;
  let mediaStorageKey = null;
  if (source.mediaStorageKey) {
    try {
      mediaStorageKey = await saveFile(organizationId, await fsp.readFile(resolvePath(source.mediaStorageKey)), extensionFor(source.mimeType));
    } catch {
      throw new StatusPostError('El archivo original ya no está disponible; creá la publicación de nuevo');
    }
  }
  return prisma.whatsappStatusPost.create({
    data: {
      organizationId, createdByUserId: userId, contentType: source.contentType, textContent: source.textContent, caption: source.caption,
      mediaStorageKey, mimeType: source.mimeType, backgroundColor: source.backgroundColor, fontStyle: source.fontStyle,
      audienceType: source.audienceType, audienceTags: source.audienceTags, audienceContactIds: source.audienceContactIds,
      publicationMode: 'NOW', status: 'draft'
    }
  });
}

async function metrics(organizationId) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [grouped, publishedToday, next] = await Promise.all([
    prisma.whatsappStatusPost.groupBy({ by: ['status'], where: { organizationId }, _count: true }),
    prisma.whatsappStatusPost.count({ where: { organizationId, publishedAt: { gte: startOfDay } } }),
    prisma.whatsappStatusPost.findFirst({ where: { organizationId, status: 'scheduled', nextAttemptAt: { gte: new Date() } }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } })
  ]);
  const byStatus = Object.fromEntries(grouped.map((row) => [row.status, row._count]));
  return { byStatus, publishedToday, scheduled: byStatus.scheduled || 0, failed: byStatus.failed || 0, nextScheduledAt: next ? next.nextAttemptAt : null };
}

module.exports = {
  StatusPostError, MAX_AUDIENCE, RETRY_DELAYS_MS, sanitizePost, emitPost, resolveAudience,
  publishNow, publishClaimed, runDue, tick, recoverStuck, expirePublished, removePost, duplicatePost, metrics
};
