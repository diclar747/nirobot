const crypto = require('crypto');
const { prisma } = require('./prisma');

const API_KEY_PREFIX = 'nr_live_';

function hashApiKey(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function createSecret() {
  const secret = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  return {
    secret,
    keyPrefix: secret.slice(0, 16),
    keyHash: hashApiKey(secret)
  };
}

function sanitizeApiKey(key) {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
    messageCount: key._count ? key._count.messages : 0,
    createdBy: key.createdBy ? { id: key.createdBy.id, name: key.createdBy.name, email: key.createdBy.email } : null
  };
}

function extractApiKey(req) {
  const authorization = req.get('authorization');
  if (authorization && /^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  const headerKey = req.get('x-api-key');
  return headerKey ? headerKey.trim() : null;
}

async function authenticateApiKey(req, _res, next) {
  try {
    const secret = extractApiKey(req);
    if (!secret) {
      res401(next, 'Falta la API key. Usá Authorization: Bearer nr_live_… o X-API-Key');
      return;
    }

    const key = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(secret) },
      include: { organization: { select: { id: true, name: true, active: true } } }
    });

    if (!key || key.revokedAt || !key.organization.active) {
      res401(next, 'API key inválida, revocada o con una organización inactiva');
      return;
    }

    req.apiAuth = {
      apiKeyId: key.id,
      organizationId: key.organizationId,
      organizationName: key.organization.name,
      scopes: key.scopes
    };
    prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}

function requireApiScope(scope) {
  return (req, _res, next) => {
    if (!req.apiAuth || !req.apiAuth.scopes.includes(scope)) {
      res403(next, 'La API key no tiene el permiso requerido');
      return;
    }
    next();
  };
}

function res401(next, message) {
  const error = new Error(message);
  error.status = 401;
  next(error);
}

function res403(next, message) {
  const error = new Error(message);
  error.status = 403;
  next(error);
}

module.exports = { API_KEY_PREFIX, hashApiKey, createSecret, sanitizeApiKey, extractApiKey, authenticateApiKey, requireApiScope };
