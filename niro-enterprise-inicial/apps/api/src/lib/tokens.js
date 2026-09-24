const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET no está configurado');
}

const ACCESS_TOKEN_TTL = '15m';
const ACCESS_TOKEN_MAX_AGE_MS = 15 * 60 * 1000;
// La sesión se renueva cada vez que se usa (ventana deslizante): mientras se entre al menos una vez por mes no vuelve a pedir QR.
const REFRESH_TOKEN_TTL = '30d';
const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

const ACCESS_COOKIE = 'niro_at';
const REFRESH_COOKIE = 'niro_rt';
const CSRF_COOKIE = 'niro_csrf';
const REFRESH_COOKIE_PATH = '/api/auth';

// impersonatorId: cuando un superadmin entró "como" este usuario desde el panel, viaja en el token para poder volver.
function signAccessToken(user, impersonatorId = null) {
  return jwt.sign(
    { sub: user.id, organizationId: user.organizationId, role: user.role, type: 'access', ...(impersonatorId ? { imp: impersonatorId } : {}) },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function signRefreshToken(user) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: user.id, type: 'refresh', jti }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
  return { token, jti };
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function setAuthCookies(res, { accessToken, refreshToken, csrfToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_MS
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_MAX_AGE_MS
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_MAX_AGE_MS
  });
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE,
  REFRESH_TOKEN_MAX_AGE_MS,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  hashToken,
  generateCsrfToken,
  setAuthCookies,
  clearAuthCookies
};
