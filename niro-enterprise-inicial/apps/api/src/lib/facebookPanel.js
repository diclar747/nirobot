// Puente con los paneles de Facebook/Instagram (niro-autofacebook-paquete, contenedor "facebook" en la
// misma red Docker). Hay UN panel por organización (supervisor.mjs del paquete): cada pedido lleva el
// header X-Niro-Org y el supervisor lo manda al panel de esa organización, con su propio Facebook.
// La contraseña técnica (FACEBOOK_PANEL_PASSWORD) nunca la ve el usuario: se usa server-a-servidor
// para conseguir la cookie de sesión del panel y devolvérsela al navegador ya logueado.

function panelUrl() {
  return String(process.env.FACEBOOK_PANEL_URL || 'http://facebook:8787').replace(/\/+$/, '');
}

function isConfigured() {
  return String(process.env.FACEBOOK_PANEL_PASSWORD || '').trim().length > 0;
}

// Solo dueños/administradores conectan y manejan las redes de la organización.
const PANEL_ROLES = new Set(['OWNER', 'ADMIN']);

// FACEBOOK_PANEL_ORG_IDS vacío o "*" = todas las organizaciones; si no, lista de ids separados por coma.
function orgAllowed(organizationId) {
  const raw = String(process.env.FACEBOOK_PANEL_ORG_IDS || '').trim();
  if (!raw || raw === '*') return true;
  return raw.split(',').map((id) => id.trim()).includes(organizationId);
}

// auth = req.auth. Durante "Entrar como cliente" (soporte) no se abre: es la cuenta de Facebook del cliente.
function canUse(auth) {
  if (!isConfigured() || !auth || !auth.organizationId || auth.impersonatorId || !PANEL_ROLES.has(auth.role)) return false;
  return orgAllowed(auth.organizationId);
}

function isInternal(req) {
  const expected = String(process.env.FACEBOOK_PANEL_PASSWORD || '');
  const received = String(req.get('x-niro-internal') || '');
  if (!expected || !received) return false;
  const crypto = require('crypto');
  const a = crypto.createHash('sha256').update(received).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function orgHeaders(organizationId, extra = {}) {
  return { 'x-niro-org': organizationId, ...extra };
}

async function loginCookie(organizationId) {
  const password = String(process.env.FACEBOOK_PANEL_PASSWORD || '').trim();
  const response = await fetch(`${panelUrl()}/api/login`, {
    method: 'POST',
    headers: orgHeaders(organizationId, { 'content-type': 'application/json' }),
    body: JSON.stringify({ password }),
    // La primera vez el supervisor crea la base y levanta el panel de la organización: puede tardar.
    signal: AbortSignal.timeout(60000)
  });
  const setCookie = response.headers.get('set-cookie');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok || !setCookie) {
    throw new Error('No se pudo iniciar sesión en el panel de Facebook');
  }
  return setCookie;
}

// Organizaciones con panel levantado ahora (para el puente de avisos).
async function runningOrgs() {
  const response = await fetch(`${panelUrl()}/__niro/children`, {
    headers: { 'x-niro-internal': String(process.env.FACEBOOK_PANEL_PASSWORD || '') },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).orgs || [];
}

module.exports = { isConfigured, canUse, isInternal, loginCookie, runningOrgs, panelUrl, orgHeaders };
