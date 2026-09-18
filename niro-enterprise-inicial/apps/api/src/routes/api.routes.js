const express = require('express');
const rateLimit = require('express-rate-limit');
const { upload } = require('../middleware/upload');
const { HttpError } = require('../lib/errors');
const { authenticateApiKey, requireApiScope } = require('../lib/apiKeys');
const { apiMessageSchema } = require('../validation/api.validation');
const { sendApiMessage } = require('../lib/apiMessages');
const { listSessions } = require('../lib/whatsapp');
const { openapi } = require('../lib/openapi');
const { MAX_SIZE, isAllowedMimeType } = require('../lib/attachments');

const router = express.Router();
const configuredRateLimit = Number(process.env.API_RATE_LIMIT || 120);
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number.isFinite(configuredRateLimit) && configuredRateLimit > 0 ? configuredRateLimit : 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.apiAuth?.apiKeyId || req.ip
});

router.get('/', (_req, res) => {
  res.json({ name: openapi.info.title, version: openapi.info.version, docs: '/api/v1/openapi.json', authentication: 'Bearer API key' });
});

router.get('/openapi.json', (_req, res) => {
  res.json(openapi);
});

router.use(authenticateApiKey, apiLimiter);

router.get('/sessions', requireApiScope('sessions:read'), (req, res) => {
  res.json({ organizationId: req.apiAuth.organizationId, sessions: listSessions(req.apiAuth.organizationId) });
});

router.post('/messages', requireApiScope('messages:send'), upload.single('file'), async (req, res, next) => {
  try {
    const raw = { ...req.body };
    const parsed = apiMessageSchema.parse(raw);
    const file = req.file || decodeBase64File(raw.mediaBase64, parsed.mimeType, parsed.fileName);
    const type = raw.type ? parsed.type : (file ? inferType(file.mimetype) : 'text');
    const result = await sendApiMessage({
      organizationId: req.apiAuth.organizationId,
      apiKeyId: req.apiAuth.apiKeyId,
      ...parsed,
      type,
      file,
      mimeType: file ? file.mimetype : parsed.mimeType,
      fileName: file ? file.originalname || parsed.fileName : parsed.fileName
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

function inferType(mimeType) {
  if (!mimeType) return 'text';
  if (mimeType === 'image/webp') return 'sticker';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

function decodeBase64File(value, mimeType, fileName) {
  if (!value) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'mediaBase64 debe ser texto base64');
  const clean = value.replace(/^data:[^;]+;base64,/, '');
  let buffer;
  try {
    buffer = Buffer.from(clean, 'base64');
  } catch {
    throw new HttpError(400, 'mediaBase64 no es válido');
  }
  if (!buffer.length || buffer.length > MAX_SIZE) throw new HttpError(400, 'mediaBase64 vacío o supera 15 MB');
  if (!mimeType || !isAllowedMimeType(mimeType)) throw new HttpError(400, 'mimeType no permitido para mediaBase64');
  return { buffer, mimetype: mimeType, originalname: fileName || 'archivo' };
}

module.exports = router;
