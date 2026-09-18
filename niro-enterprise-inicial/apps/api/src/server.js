const http = require('http');
const { app } = require('./app');
const { prisma } = require('./lib/prisma');
const { attachSocketServer } = require('./lib/realtime');
const whatsapp = require('./lib/whatsapp');
const campaigns = require('./lib/campaigns');

const port = Number(process.env.PORT || 4000);

const server = http.createServer(app);
const io = attachSocketServer(server);

server.listen(port, () => console.log(`[NIRO API] escuchando en ${port}`));

if (process.env.WHATSAPP_RESUME_SESSIONS !== 'false') {
  whatsapp.resumeSessions().catch((err) => console.error('[whatsapp] resumeSessions failed', err));
}
campaigns.resumeScheduledCampaigns().catch((err) => console.error('[campaigns] resumeScheduledCampaigns failed', err));

async function shutdown() {
  io.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
