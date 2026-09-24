const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const publicRoutes = require('./routes/public.routes');
const authRoutes = require('./routes/auth.routes');
const superadminRoutes = require('./routes/superadmin.routes');
const orgRoutes = require('./routes/org.routes');
const contactsRoutes = require('./routes/contacts.routes');
const conversationsRoutes = require('./routes/conversations.routes');
const ordersRoutes = require('./routes/orders.routes');
const reportsRoutes = require('./routes/reports.routes');
const widgetRoutes = require('./routes/widget.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');
const campaignsRoutes = require('./routes/campaigns.routes');
const aiRoutes = require('./routes/ai.routes');
const botFlowRoutes = require('./routes/bot-flow.routes');
const pushRoutes = require('./routes/push.routes');
const developerRoutes = require('./routes/developer.routes');
const apiRoutes = require('./routes/api.routes');
const callRoutes = require('./routes/call.routes');
const statusesRoutes = require('./routes/statuses.routes');
const statusPostsRoutes = require('./routes/status-posts.routes');
const statusCampaignsRoutes = require('./routes/status-campaigns.routes');
const { errorHandler } = require('./middleware/errorHandler');

const allowedOrigins = (process.env.WEB_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim());
const WIDGET_PATH_PREFIX = '/api/public/widget';

// The widget is meant to be embedded on arbitrary third-party sites, so its endpoints need an
// open CORS policy; everything else stays locked to WEB_ORIGIN. A path-based delegate keeps
// this a single cors() call instead of two differently-configured middleware stacks.
function corsOptionsDelegate(req, callback) {
  if (req.path.startsWith(WIDGET_PATH_PREFIX) || req.path.startsWith('/api/v1')) {
    return callback(null, { origin: true, credentials: false });
  }
  callback(null, { origin: allowedOrigins, credentials: true });
}

const app = express();
// Trust only explicitly configured reverse proxies. Never trust arbitrary XFF headers.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(value => value.trim()));

app.use(require('./middleware/clientIp').clientIp);
app.use(helmet());
app.use(cors(corsOptionsDelegate));
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// Salud del servicio (para monitoreo/uptime): responde 200 si la API y la base están vivas.
app.get('/api/health', async (_req, res) => {
  try {
    await require('./lib/prisma').prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});

app.use(publicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/superadmin', superadminRoutes);
const billingRoutes = require('./routes/billing.routes');
const { subscriptionGate } = require('./middleware/subscription');
app.use('/api/billing/webhook', billingRoutes.webhook);
// nginx (auth_request) consulta esto en cada pedido a /facebook/: el panel solo se usa con sesión de
// Niro viva, organización habilitada y prueba/plan al día. Solo 204/401/403 (auth_request no acepta otros).
app.get('/api/facebook/authz', require('./middleware/auth').requireAuth, async (req, res) => {
  try {
    if (!require('./lib/facebookPanel').canUse(req.auth)) return res.status(403).end();
    if (await require('./lib/billing').isBlocked(req.auth.organizationId)) return res.status(403).end();
    // nginx lo pasa al supervisor del paquete: con esto elige el panel (y el Facebook) de esta organización.
    res.set('X-Niro-Org', req.auth.organizationId).status(204).end();
  } catch {
    res.status(403).end();
  }
});
// Supervisor de paneles (interno, con la contraseña técnica): qué organizaciones tienen la prueba/plan
// vencido, para apagar sus paneles y que no publiquen solos.
app.post('/api/facebook/internal/plan-status', async (req, res) => {
  const { prisma } = require('./lib/prisma');
  const panel = require('./lib/facebookPanel');
  if (!panel.isInternal(req)) return res.status(403).json({ error: 'No autorizado' });
  const ids = Array.isArray(req.body?.orgIds) ? req.body.orgIds.filter((id) => typeof id === 'string').slice(0, 500) : [];
  const billing = require('./lib/billing');
  const blocked = [];
  for (const id of ids) {
    const org = await prisma.organization.findUnique({ where: { id }, select: { createdAt: true, trialEndsAt: true, paidUntil: true, billingExempt: true, active: true } });
    if (!org || !org.active || billing.accessFor(org).blocked) blocked.push(id);
  }
  res.json({ blocked });
});
app.use('/api/org', subscriptionGate);
app.use('/api/org/billing', billingRoutes.router);
app.use('/api/org', orgRoutes);
app.use('/api/org/contacts', contactsRoutes);
app.use('/api/org/groups', require('./routes/groups.routes'));
app.use('/api/org/history', require('./routes/history.routes'));
app.use('/api/org/sync', require('./routes/sync.routes'));
app.use('/api/org/conversations', conversationsRoutes);
app.use('/api/org/orders', ordersRoutes);
app.use('/api/org/reports', reportsRoutes);
app.use('/api/org/sms', require('./routes/sms.routes'));
app.use('/api/org/management', require('./routes/management.routes'));
app.use('/api/org/whatsapp', whatsappRoutes);
app.use('/api/org/campaigns', campaignsRoutes);
app.use('/api/org/quick-replies', require('./routes/quick-replies.routes'));
app.use('/api/org/ai', aiRoutes);
app.use('/api/org/bot-flow', botFlowRoutes);
app.use('/api/org/push', pushRoutes);
app.use('/api/org', developerRoutes);
app.use('/api/org/wa-calls', callRoutes);
app.use('/api/org/statuses', statusesRoutes);
app.use('/api/org/status-posts', statusPostsRoutes);
app.use('/api/org/status-campaigns', statusCampaignsRoutes);
app.use('/api/v1', apiRoutes);
app.use(WIDGET_PATH_PREFIX, widgetRoutes);

app.use(errorHandler);

module.exports = { app };
