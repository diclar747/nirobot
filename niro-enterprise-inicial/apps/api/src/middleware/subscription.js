const { prisma } = require('../lib/prisma');
const { requireAuth } = require('./auth');
const { accessFor } = require('../lib/billing');

// Bloquea la API de la organización cuando la prueba de 24 h venció y no hay plan pago.
// Quedan libres: facturación, avisos y notificaciones push (para poder pagar y enterarse).
const OPEN_PREFIXES = ['/billing', '/push'];

function subscriptionGate(req, res, next) {
  if (OPEN_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
  requireAuth(req, res, async (err) => {
    if (err) return next(err);
    if (!req.auth.organizationId) return next(); // SUPERADMIN
    try {
      const org = await prisma.organization.findUnique({ where: { id: req.auth.organizationId }, select: { id: true, createdAt: true, trialEndsAt: true, paidUntil: true, billingExempt: true } });
      if (!org) return next();
      const access = accessFor(org);
      if (access.blocked) {
        return res.status(402).json({ error: 'Tu período de prueba terminó. Activá el plan para seguir usando Niro.', code: 'SUBSCRIPTION_REQUIRED' });
      }
      req.billing = access;
      next();
    } catch (error) { next(error); }
  });
}

module.exports = { subscriptionGate };
