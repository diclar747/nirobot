const { verifyToken, ACCESS_COOKIE, CSRF_COOKIE } = require('../lib/tokens');
const { HttpError } = require('../lib/errors');
const { prisma } = require('../lib/prisma');
const { effectivePermissions } = require('../lib/permissions');

async function requireAuth(req, _res, next) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return next(new HttpError(401, 'No autenticado'));

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(new HttpError(401, 'Sesión inválida o expirada'));
  }
  if (payload.type !== 'access') return next(new HttpError(401, 'Token inválido'));

  let user;
  try {
    user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { organization: { select: { active: true } } } });
  } catch (error) { return next(error); }
  if (!user?.active || (user.organizationId && !user.organization?.active)) return next(new HttpError(401, 'La cuenta ya no está habilitada'));
  if (user.organizationId !== (payload.organizationId ?? null)) return next(new HttpError(401, 'La sesión cambió de organización'));
  req.auth = { userId: user.id, organizationId: user.organizationId, role: user.role, permissions: effectivePermissions(user) };
  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth) return next(new HttpError(401, 'No autenticado'));
    if (!roles.includes(req.auth.role)) return next(new HttpError(403, 'No autorizado para esta acción'));
    next();
  };
}

function requireCsrf(req, _res, next) {
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return next(new HttpError(403, 'Token CSRF inválido o ausente'));
  }
  next();
}

// Repetida antes en cada routes.js (13 copias, una con el mensaje sin tildes) — una organización
// es obligatoria para casi todo lo que cuelga de /api/org, así que queda acá junto al resto de
// los guards de auth.
function requireOrgContext(req, _res, next) {
  if (!req.auth.organizationId) return next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'));
  next();
}

module.exports = { requireAuth, requireRole, requireCsrf, requireOrgContext };
