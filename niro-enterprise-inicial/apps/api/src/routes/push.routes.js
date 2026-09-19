// Suscripción del usuario a notificaciones push (Web Push / VAPID). La clave privada nunca sale
// de acá; el navegador solo recibe la pública para generar su propia suscripción.
const express = require('express');
const { requireAuth, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const push = require('../lib/push');
const { subscribeSchema, unsubscribeSchema } = require('../validation/push.validation');

const router = express.Router();

router.use(requireAuth);

router.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: push.vapidPublicKey(), configured: push.isConfigured() });
});

router.post('/subscribe', requireCsrf, async (req, res, next) => {
  try {
    if (!push.isConfigured()) throw new HttpError(503, 'Las notificaciones push no están configuradas en el servidor');
    const data = subscribeSchema.parse(req.body);
    await push.saveSubscription(req.auth.userId, data.subscription, req.get('user-agent'));
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/subscribe', requireCsrf, async (req, res, next) => {
  try {
    const data = unsubscribeSchema.parse(req.body);
    await push.removeSubscription(req.auth.userId, data.endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
