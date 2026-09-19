const http = require('http');
const { app } = require('./app');
const { prisma } = require('./lib/prisma');
const { attachSocketServer } = require('./lib/realtime');
const whatsapp = require('./lib/whatsapp');
const whatsappQr = require('./lib/whatsappQr');
const campaigns = require('./lib/campaigns');
const callCampaigns = require('./lib/callCampaigns');

const port = Number(process.env.PORT || 4000);

const server = http.createServer(app);
const io = attachSocketServer(server);

server.listen(port, () => console.log(`[NIRO API] escuchando en ${port}`));

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

async function shutdown() {
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
