const fsp = require('fs/promises');
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');
const { resolvePath } = require('./storage');
const { sanitizeAttachment } = require('./attachments');

// One in-process timer per actively-sending campaign. Simple and sufficient for a single-server
// deployment; if this ever runs across multiple API instances, this map would need to move to a
// shared store (e.g. a DB row lock) so two instances don't both drive the same campaign.
const activeTimers = new Map();

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
          contactId: { in: sentRecipients.map((recipient) => recipient.contactId) }
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

async function recordCampaignMessage(organizationId, campaign, contactId, waMessageId) {
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
      content: campaign.message,
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
    if (!next.contact.phone) throw new Error('El contacto no tiene número de teléfono');
    let waMessageId;
    if (campaign.attachment) {
      const buffer = await readAttachmentBuffer(campaign.attachment);
      waMessageId = await whatsapp.sendMedia(organizationId, next.contact.phone, {
        buffer,
        mimetype: campaign.attachment.mimeType,
        fileName: campaign.attachment.fileName,
        caption: campaign.message
      });
    } else {
      waMessageId = await whatsapp.sendText(organizationId, next.contact.phone, campaign.message);
    }
    await prisma.campaignRecipient.update({
      where: { id: next.id },
      data: { status: 'SENT', waMessageId: waMessageId || null, sentAt: new Date() }
    });
    await recordCampaignMessage(organizationId, campaign, next.contact.id, waMessageId);
  } catch (err) {
    await prisma.campaignRecipient.update({
      where: { id: next.id },
      data: { status: 'FAILED', errorMessage: String((err && err.message) || err).slice(0, 300) }
    });
  }

  await emitCampaignUpdate(organizationId, campaignId);

  const messagesPerHour = campaign.messagesPerHour || Math.max(1, (campaign.ratePerMinute || 1) * 60);
  const delayMs = Math.max(1000, Math.round(3600000 / Math.max(1, messagesPerHour)));
  const timer = setTimeout(() => {
    processNext(organizationId, campaignId).catch((err) => console.error('[campaigns] processNext failed', err));
  }, delayMs);
  activeTimers.set(campaignId, timer);
}

// Marks a recipient's message as delivered/read from a Baileys delivery-receipt update. Also
// used to update a regular 1:1 Message row when the waMessageId matches one instead.
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
      await prisma.message.updateMany({ where: { waMessageId }, data: { deliveryStatus: label } });
      await emitCampaignUpdate(updated.campaign.organizationId, updated.campaignId);
    }
    return;
  }

  const message = await prisma.message.findFirst({ where: { waMessageId } });
  if (message) {
    const label = statusLevel >= 4 ? 'read' : statusLevel >= 3 ? 'delivered' : 'sent';
    await prisma.message.update({ where: { id: message.id }, data: { deliveryStatus: label } });
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
  resumeScheduledCampaigns
};
