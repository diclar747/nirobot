const http = require('http');
const { app } = require('./app');
const { prisma } = require('./lib/prisma');
const { attachSocketServer } = require('./lib/realtime');
const whatsapp = require('./lib/whatsapp');
const whatsappQr = require('./lib/whatsappQr');
const campaigns = require('./lib/campaigns');
const callCampaigns = require('./lib/callCampaigns');

// A stray rejected promise (e.g. a WhatsApp socket closing mid-send) must not take the whole
// process down and disconnect every organization.
process.on('unhandledRejection', (reason) => console.error('[process] unhandledRejection', reason));

const port = Number(process.env.PORT || 4000);

const server = http.createServer(app);
const io = attachSocketServer(server);

server.listen(port, () => console.log(`[NIRO API] escuchando en ${port}`));
require('./lib/facebookBridge').start();

if (process.env.WHATSAPP_RESUME_SESSIONS !== 'false') {
  whatsapp.resumeSessions().catch((err) => console.error('[whatsapp] resumeSessions failed', err));
}
campaigns.resumeScheduledCampaigns().catch((err) => console.error('[campaigns] resumeScheduledCampaigns failed', err));
// Campañas que quedaron "enviando" cuando el proceso murió a mitad de camino (deploy, crash,
// reinicio): sin esto se quedan colgadas para siempre, con destinatarios pendientes que nadie
// vuelve a tocar.
campaigns.resumeSendingCampaigns().catch((err) => console.error('[campaigns] resumeSendingCampaigns failed', err));
callCampaigns.resumeScheduledCampaigns().catch((err) => console.error('[wa-calls] resumeScheduledCampaigns failed', err));
callCampaigns.resumeRunningCampaigns().catch((err) => console.error('[wa-calls] resumeRunningCampaigns failed', err));

// QR logins create a temporary inactive organization per attempt. The in-memory flow that owned it
// dies with the process, so sweep the abandoned ones (never activated, no users) on boot.
async function sweepAbandonedQrOrganizations() {
  const result = await prisma.organization.deleteMany({
    where: { active: false, name: 'Nueva empresa Niro', users: { none: {} }, createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } }
  });
  if (result.count) console.log(`[auth-qr] ${result.count} organizaciones temporales abandonadas eliminadas`);
}
sweepAbandonedQrOrganizations().catch((err) => console.error('[auth-qr] sweep failed', err));

// Statuses last 24 h: drop the expired ones (and their files) periodically.
const whatsappStatus = require('./lib/whatsappStatus');
const statusCleanupTimer = setInterval(() => {
  whatsappStatus.cleanupExpired().catch((err) => console.error('[status] cleanup failed', err));
}, 60 * 60 * 1000);
statusCleanupTimer.unref?.();

let stopping = false;

// Publishing queue for statuses posted from Nirobot: scheduled posts, retries and crash recovery.
const statusPosts = require('./lib/statusPosts');
let statusPostsBusy = false;
async function statusPostsTick() {
  if (statusPostsBusy || stopping) return;
  statusPostsBusy = true;
  try { await statusPosts.tick(); } catch (err) { console.error('[status-posts] tick failed', err); } finally { statusPostsBusy = false; }
}
const statusPostsTimer = setInterval(statusPostsTick, 30 * 1000);
statusPostsTimer.unref?.();
setTimeout(statusPostsTick, 15 * 1000).unref?.();
whatsappStatus.cleanupExpired().catch((err) => console.error('[status] cleanup failed', err));

// SMS masivo: retoma las campañas en curso tras un reinicio y arranca las programadas cuando les toca.
const smsService = require('./lib/sms');
smsService.resumeCampaigns().catch((err) => console.error('[sms] resumeCampaigns failed', err));
let smsBusy = false;
const smsTimer = setInterval(async () => {
  if (smsBusy || stopping) return;
  smsBusy = true;
  try { await smsService.tick(); } catch (err) { console.error('[sms] tick failed', err); } finally { smsBusy = false; }
}, 20 * 1000);
smsTimer.unref?.();

async function shutdown() {
  stopping = true;
  io.close();
  server.close();
  await callCampaigns.shutdown();
  await whatsappQr.shutdown();
  await whatsapp.shutdown();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
