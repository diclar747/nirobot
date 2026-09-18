const express = require('express');
const rateLimit = require('express-rate-limit');
const { prisma } = require('../lib/prisma');
const { hashPassword, verifyPassword } = require('../lib/passwords');
const {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  hashToken,
  generateCsrfToken,
  setAuthCookies,
  clearAuthCookies,
  REFRESH_COOKIE,
  REFRESH_TOKEN_MAX_AGE_MS
} = require('../lib/tokens');
const { audit } = require('../lib/audit');
const { requireAuth, requireCsrf } = require('../middleware/auth');
const { loginSchema, changePasswordSchema } = require('../validation/auth.validation');
const { HttpError } = require('../lib/errors');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    mustChangePassword: user.mustChangePassword,
    organization: user.organization
      ? { id: user.organization.id, name: user.organization.name, slug: user.organization.slug }
      : null
  };
}

async function issueSession(res, user, req) {
  const accessToken = signAccessToken(user);
  const { token: refreshToken, jti } = signRefreshToken(user);
  const csrfToken = generateCsrfToken();

  await prisma.refreshToken.create({
    data: {
      id: jti,
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
      userAgent: req.get('user-agent') || null,
      ip: req.ip || null
    }
  });

  setAuthCookies(res, { accessToken, refreshToken, csrfToken });
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email }, include: { organization: true } });

    const invalid = () => {
      throw new HttpError(401, 'Credenciales inválidas');
    };

    if (!user || !user.active) invalid();
    if (user.organizationId && (!user.organization || !user.organization.active)) invalid();

    const passwordOk = await verifyPassword(password, user.passwordHash);
    if (!passwordOk) {
      await audit(prisma, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'auth.login.failure',
        entityType: 'User',
        entityId: user.id
      });
      invalid();
    }

    await issueSession(res, user, req);
    await audit(prisma, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'auth.login.success',
      entityType: 'User',
      entityId: user.id
    });

    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new HttpError(401, 'No hay sesión activa');

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      throw new HttpError(401, 'Sesión inválida o expirada');
    }
    if (payload.type !== 'refresh') throw new HttpError(401, 'Token inválido');

    const tokenHash = hashToken(token);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.expiresAt < new Date()) {
      clearAuthCookies(res);
      throw new HttpError(401, 'Sesión expirada, iniciá sesión nuevamente');
    }

    if (stored.revokedAt) {
      // Reuse of an already-rotated/revoked token: possible theft, kill every session for this user.
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      clearAuthCookies(res);
      throw new HttpError(401, 'Sesión inválida, iniciá sesión nuevamente');
    }

    const user = await prisma.user.findUnique({ where: { id: stored.userId }, include: { organization: true } });
    if (!user || !user.active || (user.organizationId && (!user.organization || !user.organization.active))) {
      await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      clearAuthCookies(res);
      throw new HttpError(401, 'Cuenta no disponible');
    }

    const accessToken = signAccessToken(user);
    const { token: newRefreshToken, jti } = signRefreshToken(user);
    const csrfToken = generateCsrfToken();
    const newHash = hashToken(newRefreshToken);

    await prisma.$transaction([
      prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date(), replacedByHash: newHash } }),
      prisma.refreshToken.create({
        data: {
          id: jti,
          userId: user.id,
          tokenHash: newHash,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
          userAgent: req.get('user-agent') || null,
          ip: req.ip || null
        }
      })
    ]);

    setAuthCookies(res, { accessToken, refreshToken: newRefreshToken, csrfToken });
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      const tokenHash = hashToken(token);
      await prisma.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    clearAuthCookies(res);
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'auth.logout',
      entityType: 'User',
      entityId: req.auth.userId
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth.userId }, include: { organization: true } });
    if (!user || !user.active) {
      clearAuthCookies(res);
      throw new HttpError(401, 'Sesión inválida');
    }
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireAuth, requireCsrf, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth.userId } });
    if (!user) throw new HttpError(401, 'Sesión inválida');

    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) throw new HttpError(400, 'La contraseña actual es incorrecta');

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } }),
      prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } })
    ]);

    const updated = await prisma.user.findUnique({ where: { id: user.id }, include: { organization: true } });
    await issueSession(res, updated, req);
    await audit(prisma, {
      organizationId: updated.organizationId,
      actorUserId: updated.id,
      action: 'auth.password.changed',
      entityType: 'User',
      entityId: updated.id
    });

    res.json({ user: sanitizeUser(updated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
