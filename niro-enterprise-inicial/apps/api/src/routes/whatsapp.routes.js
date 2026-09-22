const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const whatsapp = require('../lib/whatsapp');

const router = express.Router();

router.use(requireAuth, requireOrgContext);

router.get('/status', (req, res) => {
  res.json(whatsapp.getStatus(req.auth.organizationId));
});

router.get('/sessions', (req, res) => {
  res.json({ sessions: whatsapp.listSessions(req.auth.organizationId) });
});

router.post('/sync-contacts', requireCsrf, requirePermission('contacts'), async (req, res, next) => {
  try {
    if (!(await require('../lib/whatsappSync').isEnabled(req.auth.organizationId, 'contacts'))) {
      throw new HttpError(403, 'Activá “Descargar contactos” en Configuración → Sincronización con WhatsApp para importar la libreta.');
    }
    const result = await whatsapp.syncContacts(req.auth.organizationId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/sync-avatars', requireCsrf, requirePermission('contacts'), async (req, res, next) => {
  if (!(await require('../lib/whatsappSync').isEnabled(req.auth.organizationId, 'avatars'))) {
    return next(new HttpError(403, 'Activá “Descargar avatares” en Configuración → Sincronización con WhatsApp.'));
  }
  // Runs in the background (it is throttled on purpose); answer immediately.
  whatsapp.backfillAvatars(req.auth.organizationId).catch(() => {});
  res.status(202).json({ started: true });
});

router.post('/connect', requireCsrf, requireRole('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    const status = await whatsapp.connect(req.auth.organizationId, { fresh: true });
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
