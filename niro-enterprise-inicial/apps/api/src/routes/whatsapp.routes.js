const express = require('express');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const whatsapp = require('../lib/whatsapp');

const router = express.Router();

function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta accion requiere pertenecer a una organizacion'));
  next();
}

router.use(requireAuth, requireOrgContext);

router.get('/status', (req, res) => {
  res.json(whatsapp.getStatus(req.auth.organizationId));
});

router.get('/sessions', (req, res) => {
  res.json({ sessions: whatsapp.listSessions(req.auth.organizationId) });
});

router.post('/sync-contacts', requireCsrf, requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  try {
    const result = await whatsapp.syncContacts(req.auth.organizationId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/connect', requireCsrf, requireRole('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    const status = await whatsapp.connect(req.auth.organizationId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.post('/disconnect', requireCsrf, requireRole('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    await whatsapp.disconnect(req.auth.organizationId);
    res.json({ status: 'disconnected', qr: null, phone: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
