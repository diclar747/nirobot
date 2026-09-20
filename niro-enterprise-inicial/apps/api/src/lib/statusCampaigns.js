// Status campaigns: a series of WhatsApp statuses that go out by themselves every N hours.
// Each item is a scheduled WhatsappStatusPost, so the existing worker (statusPosts.tick) publishes,
// retries and expires them; the campaign only groups them and can pause/resume/cancel the series.
const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');
const posts = require('./statusPosts');

const ALLOWED_INTERVALS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 24, 36, 48, 72, 168];
const MAX_ITEMS = 60;
const RESUME_LEAD_MS = 60 * 1000;

function slotTime(startAt, intervalHours, index) {
  return new Date(startAt.getTime() + index * intervalHours * 3600 * 1000);
}

function sanitizeCampaign(campaign, counts = {}) {
  const total = campaign.totalItems;
  const published = counts.published || 0;
  return {
    id: campaign.id,
    name: campaign.name,
    intervalHours: campaign.intervalHours,
    startAt: campaign.startAt,
    replacePrevious: campaign.replacePrevious,
    status: campaign.status,
    totalItems: total,
    published,
    pending: counts.pending || 0,
    failed: counts.failed || 0,
    nextAt: counts.nextAt || null,
    endsAt: slotTime(campaign.startAt, campaign.intervalHours, Math.max(0, total - 1)),
    createdAt: campaign.createdAt
  };
}

async function summarize(campaigns) {
  if (!campaigns.length) return [];
  const rows = await prisma.whatsappStatusPost.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: campaigns.map((c) => c.id) } }, _count: true });
  const next = await prisma.whatsappStatusPost.groupBy({ by: ['campaignId'], where: { campaignId: { in: campaigns.map((c) => c.id) }, status: 'scheduled' }, _min: { nextAttemptAt: true } });
  const nextById = Object.fromEntries(next.map((n) => [n.campaignId, n._min.nextAttemptAt]));
  return campaigns.map((campaign) => {
    const mine = rows.filter((r) => r.campaignId === campaign.id);
    const count = (...statuses) => mine.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r._count, 0);
    return sanitizeCampaign(campaign, {
      published: count('published', 'expired', 'deleted'),
      pending: count('scheduled', 'processing'),
      failed: count('failed'),
      nextAt: nextById[campaign.id] || null
    });
  });
}

// A campaign whose items were all published/cancelled is finished, whatever it was before.
async function refreshStatus(campaignId) {
  const campaign = await prisma.whatsappStatusCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status !== 'active') return campaign;
  const open = await prisma.whatsappStatusPost.count({ where: { campaignId, status: { in: ['scheduled', 'processing', 'draft'] } } });
  if (open > 0) return campaign;
  return prisma.whatsappStatusCampaign.update({ where: { id: campaignId }, data: { status: 'completed' } });
}

async function refreshActive() {
  const active = await prisma.whatsappStatusCampaign.findMany({ where: { status: 'active' }, select: { id: true } });
  for (const { id } of active) {
    const before = await prisma.whatsappStatusCampaign.findUnique({ where: { id } });
    const after = await refreshStatus(id);
    if (after && before && after.status !== before.status) emitCampaign(after);
  }
}

async function pause(organizationId, id) {
  const campaign = await prisma.whatsappStatusCampaign.findFirst({ where: { id, organizationId } });
  if (!campaign) return null;
  if (campaign.status !== 'active') throw new posts.StatusPostError('Solo se puede pausar una campaña activa');
  return prisma.whatsappStatusCampaign.update({ where: { id }, data: { status: 'paused' } });
}

// While paused the worker skips the items, so on resume any overdue ones are pushed forward
// (keeping the spacing between them) instead of all firing at once.
async function resume(organizationId, id) {
  const campaign = await prisma.whatsappStatusCampaign.findFirst({ where: { id, organizationId } });
  if (!campaign) return null;
  if (campaign.status !== 'paused') throw new posts.StatusPostError('Solo se puede reanudar una campaña pausada');
  const pending = await prisma.whatsappStatusPost.findMany({ where: { campaignId: id, status: 'scheduled' }, orderBy: { sequence: 'asc' } });
  if (pending.length) {
    const earliest = pending[0].nextAttemptAt.getTime();
    const floor = Date.now() + RESUME_LEAD_MS;
    const shift = Math.max(0, floor - earliest);
    if (shift > 0) {
      for (const post of pending) {
        const at = new Date(post.nextAttemptAt.getTime() + shift);
        await prisma.whatsappStatusPost.update({ where: { id: post.id }, data: { nextAttemptAt: at, scheduledAt: at } });
      }
    }
  }
  return prisma.whatsappStatusCampaign.update({ where: { id }, data: { status: 'active' } });
}

// Cancels every item that has not gone out yet. Statuses already published stay until they expire.
async function cancel(organizationId, id) {
  const campaign = await prisma.whatsappStatusCampaign.findFirst({ where: { id, organizationId } });
  if (!campaign) return null;
  const pending = await prisma.whatsappStatusPost.findMany({ where: { campaignId: id, status: { in: ['scheduled', 'draft', 'failed'] } }, select: { id: true } });
  for (const { id: postId } of pending) await posts.removePost(organizationId, postId);
  return prisma.whatsappStatusCampaign.update({ where: { id }, data: { status: 'cancelled' } });
}

function emitCampaign(campaign) {
  emitToOrg(campaign.organizationId, 'status-campaign:updated', { campaignId: campaign.id, status: campaign.status });
}

module.exports = { ALLOWED_INTERVALS, MAX_ITEMS, slotTime, sanitizeCampaign, summarize, refreshStatus, refreshActive, pause, resume, cancel, emitCampaign };
