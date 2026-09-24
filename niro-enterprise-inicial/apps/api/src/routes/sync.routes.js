const express = require('express');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const sync = require('../lib/whatsappSync');

const router = express.Router();
router.use(requireAuth, requireOrgContext);
router.use(requireRole('OWNER', 'ADMIN'));

const wrap = (err, next) => next(err && err.status ? new HttpError(err.status, err.message) : err);

router.get('/', async (req, res, next) => {
  try { res.json(await sync.getState(req.auth.organizationId)); } catch (err) { next(err); }
});

// Body: { groups?: bool, contacts?: bool, message_history?: bool, avatars?: bool, statuses?: bool } — cada opción es independiente.
router.patch('/', requireCsrf, async (req, res, next) => {
  try { res.json(await sync.updateSettings(req.auth.organizationId, req.auth.userId, req.body || {}, req.ip)); } catch (err) { next(err); }
});

router.post('/:type/run', requireCsrf, async (req, res, next) => {
  try {
    const job = await sync.startJob(req.auth.organizationId, req.params.type, req.auth.userId);
    res.status(202).json({ job: sync.sanitizeJob(job) });
  } catch (err) { wrap(err, next); }
});

router.post('/:type/cancel', requireCsrf, async (req, res, next) => {
  try {
    if (!sync.TYPES.includes(req.params.type)) throw new HttpError(400, 'Tipo inválido');
    const job = await sync.cancelJob(req.auth.organizationId, req.params.type, req.auth.userId);
    res.json({ job: sync.sanitizeJob(job) });
  } catch (err) { wrap(err, next); }
});

router.delete('/:type/data', requireCsrf, async (req, res, next) => {
  try {
    const removed = await sync.deleteImported(req.auth.organizationId, req.params.type, req.auth.userId);
    res.json({ removed });
  } catch (err) { wrap(err, next); }
});

module.exports = router;
