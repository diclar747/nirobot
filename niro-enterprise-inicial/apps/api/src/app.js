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

app.use(publicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/superadmin', superadminRoutes);
const billingRoutes = require('./routes/billing.routes');
const { subscriptionGate } = require('./middleware/subscription');
app.use('/api/billing/webhook', billingRoutes.webhook);
app.use('/api/org', subscriptionGate);
app.use('/api/org/billing', billingRoutes.router);
app.use('/api/org', orgRoutes);
app.use('/api/org/contacts', contactsRoutes);
app.use('/api/org/conversations', conversationsRoutes);
app.use('/api/org/orders', ordersRoutes);
app.use('/api/org/reports', reportsRoutes);
app.use('/api/org/whatsapp', whatsappRoutes);
app.use('/api/org/campaigns', campaignsRoutes);
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
