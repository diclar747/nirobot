const fsp = require('fs/promises');
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');
const { resolvePath } = require('./storage');
const { sanitizeAttachment } = require('./attachments');

// One in-process timer per actively-sending campaign. Simple and sufficient for a single-server
// deployment; if this ever runs across multiple API instances, this map would need to move to a
// shared store (e.g. a DB row lock) so two instances don't both drive the same campaign.
const activeTimers = new Map();

const { personalizeCampaignMessage } = require('./campaignVariables');

function sanitizeCampaign(campaign, counts) {
  return {
    id: campaign.id,
    name: campaign.name,
    message: campaign.message,
    attachment: campaign.attachment ? sanitizeAttachment(campaign.attachment) : null,
    tagFilter: campaign.tagFilter,
    sendLine: campaign.sendLine || null,
    campaignType: campaign.campaignType || (campaign.scheduledAt ? 'SCHEDULED' : 'DIRECT'),
    speedProfile: campaign.speedProfile || 'BALANCED',
    messagesPerHour: campaign.messagesPerHour || Math.max(1, Math.round((campaign.ratePerMinute || 20) * 60)),
    ratePerMinute: campaign.ratePerMinute,
    status: campaign.status,
    scheduledAt: campaign.scheduledAt,
    startedAt: campaign.startedAt,
    completedAt: campaign.completedAt,
    createdBy: campaign.createdBy ? { id: campaign.createdBy.id, name: campaign.createdBy.name } : null,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    counts: counts || null
  };
}

async function getCounts(campaignId) {
  const [grouped, campaign, recipients] = await Promise.all([
    prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: true
    }),
    prisma.campaign.findUnique({ where: { id: campaignId }, select: { organizationId: true, createdAt: true } }),
    prisma.campaignRecipient.findMany({ where: { campaignId }, select: { contactId: true, sentAt: true } })
  ]);
  const counts = { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, replies: 0 };
  for (const g of grouped) {
    counts.total += g._count;
    counts[g.status.toLowerCase()] = g._count;
  }
  const sentRecipients = recipients.filter((recipient) => recipient.sentAt);
  if (campaign && sentRecipients.length > 0) {
    const firstSentAt = sentRecipients.reduce((earliest, recipient) => recipient.sentAt < earliest ? recipient.sentAt : earliest, sentRecipients[0].sentAt);
    counts.replies = await prisma.message.count({
      where: {
        direction: 'INBOUND',
        createdAt: { gte: firstSentAt },
        conversation: {
          organizationId: campaign.organizationId,
          contactId: { in: sentRecipients.map((recipient) => recipient.contactId).filter(Boolean) }
        }
      }
    });
  }
  return counts;
}

async function emitCampaignUpdate(organizationId, campaignId) {
  const [campaign, counts] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaignId }, include: { attachment: true, createdBy: true } }),
    getCounts(campaignId)
  ]);
  if (!campaign) return;
  emitToOrg(organizationId, 'campaign:updated', { campaign: sanitizeCampaign(campaign, counts) });
}

async function startCampaign(organizationId, campaignId) {
  pauseCampaign(campaignId);
  const campaign = await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'SENDING', startedAt: new Date() }
  });
  processNext(organizationId, campaignId).catch((err) => console.error('[campaigns] processNext failed', err));
  return campaign;
}

const MAX_TIMER_DELAY = 2 ** 31 - 1;

function scheduleCampaign(organizationId, campaignId, scheduledAt) {
  pauseCampaign(campaignId);
  const dueAt = new Date(scheduledAt).getTime();
  const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, dueAt - Date.now()));
  const timer = setTimeout(async () => {
    activeTimers.delete(campaignId);
    const current = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true, scheduledAt: true } });
    if (!current || current.status !== 'SCHEDULED') return;
    if (current.scheduledAt && current.scheduledAt.getTime() > Date.now()) {
      scheduleCampaign(organizationId, campaignId, current.scheduledAt);
      return;
    }
    await startCampaign(organizationId, campaignId);
  }, delay);
  activeTimers.set(campaignId, timer);
}

async function resumeScheduledCampaigns() {
  const scheduled = await prisma.campaign.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { not: null } },
    select: { id: true, organizationId: true, scheduledAt: true }
  });
  for (const campaign of scheduled) scheduleCampaign(campaign.organizationId, campaign.id, campaign.scheduledAt);
  return scheduled.length;
}

async function waitForWhatsappConnected(organizationId, options = {}) {
  const whatsapp = require('./whatsapp');
  // Read at call time (not as module-level constants) so tests can shrink these via env vars
  // without needing to reset the module cache.
  const timeoutMs = options.timeoutMs ?? Number(process.env.CAMPAIGN_RESUME_TIMEOUT_MS || 30000);
  const intervalMs = options.intervalMs ?? Number(process.env.CAMPAIGN_RESUME_INTERVAL_MS || 1500);
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (whatsapp.getStatus(organizationId).status === 'connected') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// A campaign left in SENDING when the process died (crash, deploy, restart) has no timer left —
// its setTimeout chain lived only in memory. On boot, every such campaign gets nudged again so it
// keeps going instead of sitting there forever with recipients stuck as PENDING. Each campaign
// waits (in the background, without blocking server startup) for its organization's WhatsApp
// session to reconnect before resuming, so it doesn't burn through recipients marking them FAILED
// during the few seconds Baileys takes to relink. If a session doesn't come back in time (e.g. it
// needs a fresh QR scan), the campaign is simply left as-is — pausing and starting it again from
// the UI remains the manual fallback.
async function resumeSendingCampaigns() {
  const stuck = await prisma.campaign.findMany({
    where: { status: 'SENDING' },
    select: { id: true, organizationId: true }
  });
  for (const campaign of stuck) {
    waitForWhatsappConnected(campaign.organizationId)
      .then((connected) => {
        if (!connected) {
          console.warn(
            `[campaigns] no se pudo reanudar la campaña ${campaign.id}: WhatsApp de la organización ${campaign.organizationId} no reconectó a tiempo`
          );
          return;
        }
        return processNext(campaign.organizationId, campaign.id);
      })
      .catch((err) => console.error('[campaigns] resumeSendingCampaigns failed for', campaign.id, err));
  }
  return stuck.length;
}

function pauseCampaign(campaignId) {
  const timer = activeTimers.get(campaignId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(campaignId);
  }
}

function clearAllTimers() {
  for (const timer of activeTimers.values()) clearTimeout(timer);
  activeTimers.clear();
}

async function readAttachmentBuffer(attachment) {
  return fsp.readFile(resolvePath(attachment.storageKey));
}

async function recordCampaignMessage(organizationId, campaign, contactId, waMessageId, renderedMessage) {
  if (!waMessageId) return;
  let conversation = await prisma.conversation.findFirst({
    where: { organizationId, contactId, channel: 'whatsapp', status: { not: 'CLOSED' } },
    orderBy: { updatedAt: 'desc' }
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { organizationId, contactId, channel: 'whatsapp', subject: `Campaña: ${campaign.name}` }
    });
  }
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      content: renderedMessage || campaign.message,
      contentType: campaign.attachment ? 'campaign-media' : 'campaign',
      deliveryStatus: 'sent',
      waMessageId,
      campaignId: campaign.id
    }
  });
}

async function processNext(organizationId, campaignId) {
  const whatsapp = require('./whatsapp');
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { attachment: true } });
  if (!campaign || campaign.status !== 'SENDING') {
    activeTimers.delete(campaignId);
    return;
  }

  // Plan vencido: se pausa la campaña en vez de seguir enviando.
  if (await require('./billing').isBlocked(organizationId).catch(() => false)) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } });
    activeTimers.delete(campaignId);
    console.warn(`[campaigns] campaña ${campaignId} pausada: plan vencido`);
    await emitCampaignUpdate(organizationId, campaignId);
    return;
  }

  // Without a live WhatsApp session every send would throw and burn through the recipient list
  // as FAILED. Pause instead, so the operator can reconnect and resume where it stopped.
  if (whatsapp.getStatus(organizationId).status !== 'connected') {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } });
    activeTimers.delete(campaignId);
    console.warn(`[campaigns] campaña ${campaignId} pausada: WhatsApp no está conectado`);
    await emitCampaignUpdate(organizationId, campaignId);
    return;
  }

  const next = await prisma.campaignRecipient.findFirst({
    where: { campaignId, status: 'PENDING' },
    include: { contact: true },
    orderBy: { createdAt: 'asc' }
  });

  if (!next) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED', completedAt: new Date() } });
    activeTimers.delete(campaignId);
    await emitCampaignUpdate(organizationId, campaignId);
    return;
  }

  try {
    const isGroup = Boolean(next.groupJid);
    const target = isGroup ? next.groupJid : next.contact && next.contact.phone;
    if (!target) throw new Error('El contacto no tiene número de teléfono');
    const renderedMessage = personalizeCampaignMessage(campaign.message, isGroup ? { name: next.groupName || 'grupo', phone: '', email: '' } : next.contact);
    let waMessageId;
    if (campaign.attachment) {
      const buffer = await readAttachmentBuffer(campaign.attachment);
      waMessageId = await whatsapp.sendMedia(organizationId, target, {
        buffer,
        mimetype: campaign.attachment.mimeType,
        fileName: campaign.attachment.fileName,
        caption: renderedMessage
      });
    } else {
      waMessageId = await whatsapp.sendText(organizationId, target, renderedMessage);
    }
    await prisma.campaignRecipient.update({
      where: { id: next.id },
      data: { status: 'SENT', waMessageId: waMessageId || null, sentAt: new Date() }
    });
    if (!isGroup) await recordCampaignMessage(organizationId, campaign, next.contact.id, waMessageId, renderedMessage);
  } catch (err) {
    await prisma.campaignRecipient.update({
      where: { id: next.id },
      data: { status: 'FAILED', errorMessage: String((err && err.message) || err).slice(0, 300) }
    });
  }

  await emitCampaignUpdate(organizationId, campaignId);

  const stillSending = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  if (!stillSending || stillSending.status !== 'SENDING') return;

  const messagesPerHour = campaign.messagesPerHour || Math.max(1, (campaign.ratePerMinute || 1) * 60);
  const delayMs = Math.max(1000, Math.round(3600000 / Math.max(1, messagesPerHour)));
  const timer = setTimeout(() => {
    processNext(organizationId, campaignId).catch((err) => console.error('[campaigns] processNext failed', err));
  }, delayMs);
  activeTimers.set(campaignId, timer);
}

// Marks a recipient's message as delivered/read from a Baileys delivery-receipt update. Also
// used to update a regular 1:1 Message row when the waMessageId matches one instead.
const MESSAGE_INCLUDE_LOCAL = { sender: { select: { id: true, name: true } }, attachment: true };

async function handleDeliveryUpdate(waMessageId, statusLevel) {
  if (!waMessageId) return;

  const recipient = await prisma.campaignRecipient.findFirst({ where: { waMessageId } });
  if (recipient) {
    const data = {};
    if (statusLevel >= 3 && recipient.status !== 'READ') data.status = 'DELIVERED';
    if (statusLevel >= 4) data.status = 'READ';
    if (statusLevel >= 3 && !recipient.deliveredAt) data.deliveredAt = new Date();
    if (statusLevel >= 4 && !recipient.readAt) data.readAt = new Date();
    if (Object.keys(data).length > 0) {
      const updated = await prisma.campaignRecipient.update({ where: { id: recipient.id }, data, include: { campaign: true } });
      const label = statusLevel >= 4 ? 'read' : statusLevel >= 3 ? 'delivered' : 'sent';
      await applyMessageStatus(waMessageId, label);
      await emitCampaignUpdate(updated.campaign.organizationId, updated.campaignId);
    }
    return;
  }

  const label = statusLevel >= 4 ? 'read' : statusLevel >= 3 ? 'delivered' : 'sent';
  await applyMessageStatus(waMessageId, label);
}

const STATUS_RANK = { failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 };

// Sube el estado de un mensaje 1:1 (nunca lo baja: un "sent" tardío no pisa un "read") y avisa en vivo al inbox.
async function applyMessageStatus(waMessageId, label) {
  const rows = await prisma.message.findMany({ where: { waMessageId, direction: 'OUTBOUND' }, include: MESSAGE_INCLUDE_LOCAL });
  for (const row of rows) {
    if ((STATUS_RANK[label] || 0) <= (STATUS_RANK[row.deliveryStatus] || 0)) continue;
    const updated = await prisma.message.update({ where: { id: row.id }, data: { deliveryStatus: label }, include: MESSAGE_INCLUDE_LOCAL });
    const conversation = await prisma.conversation.findUnique({ where: { id: row.conversationId }, select: { organizationId: true } });
    if (conversation) {
      const { sanitizeMessage } = require('./conversations');
      require('./realtime').emitToOrg(conversation.organizationId, 'message:updated', { conversationId: row.conversationId, message: sanitizeMessage(updated) });
    }
  }
}

async function retryFailed(organizationId, campaignId) {
  await prisma.campaignRecipient.updateMany({
    where: { campaignId, status: 'FAILED' },
    data: { status: 'PENDING', errorMessage: null }
  });
  return startCampaign(organizationId, campaignId);
}

async function resendCampaign(organizationId, campaignId) {
  await prisma.campaignRecipient.updateMany({
    where: { campaignId },
    data: {
      status: 'PENDING',
      waMessageId: null,
      errorMessage: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null
    }
  });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'DRAFT', startedAt: null, completedAt: null }
  });
  return startCampaign(organizationId, campaignId);
}

module.exports = {
  processNext,
  sanitizeCampaign,
  getCounts,
  startCampaign,
  pauseCampaign,
  clearAllTimers,
  retryFailed,
  resendCampaign,
  handleDeliveryUpdate,
  emitCampaignUpdate,
  scheduleCampaign,
  resumeScheduledCampaigns,
  resumeSendingCampaigns,
  personalizeCampaignMessage
};
