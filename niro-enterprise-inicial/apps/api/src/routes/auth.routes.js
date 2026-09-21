const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
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
const { loginSchema, changePasswordSchema, whatsappQrCompleteSchema } = require('../validation/auth.validation');
const { HttpError } = require('../lib/errors');
const whatsapp = require('../lib/whatsapp');
const whatsappQr = require('../lib/whatsappQr');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const qrLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // El acceso QR puede reintentarse por pestañas, reinicios y renovación de
  // códigos. El flujo sigue ligado a una cookie de navegador y no debe
  // bloquearse después de unos pocos reintentos legítimos.
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    error: 'Demasiados intentos de QR. Esperá un momento y generá un código nuevo.'
  })
});

// El estado QR se consulta periódicamente mientras el usuario escanea. Usa
// un límite separado para que el polling normal no bloquee un flujo válido.
const qrStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false
});

const qrLoginFlows = new Map();
const qrStartLocks = new Map();
const QR_FLOW_TTL_MS = 10 * 60 * 1000;
const QR_FLOW_COOKIE = 'niro_qr_flow';

function newFlowId() {
  return `qr${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizePhone(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

// El número de WhatsApp es la única señal que permite recuperar una
// organización ya existente. Nunca se debe elegir "la única organización" de
// la base, porque el siguiente QR podría terminar viendo conversaciones de
// otra empresa.
async function findOrganizationByWhatsAppPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const accounts = await prisma.callAccount.findMany({
    select: {
      phoneNumber: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          active: true,
          users: {
            where: { role: 'OWNER', active: true },
            select: { id: true }
          }
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  return accounts.find((account) => (
    account.organization?.active
    && normalizePhone(account.phoneNumber) === normalizedPhone
  ))?.organization || null;
}

function qrPayload(flowId, status, extra = {}) {
  return {
    flowId,
    status: status.status,
    qr: status.qr || null,
    phone: status.phone || null,
    lastError: status.lastError || null,
    ...extra
  };
}

function setQrFlowCookie(res, flowId, binding) {
  res.cookie(QR_FLOW_COOKIE, `${flowId}.${binding}`, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path: '/api/auth/whatsapp',
    maxAge: QR_FLOW_TTL_MS
  });
}

function clearQrFlowCookie(res) {
  res.clearCookie(QR_FLOW_COOKIE, { path: '/api/auth/whatsapp' });
}

function assertQrBrowser(req, flowId, flow) {
  const cookie = String(req.cookies?.[QR_FLOW_COOKIE] || '');
  const [cookieFlowId, binding] = cookie.split('.');
  if (!binding || cookieFlowId !== flowId || hashToken(binding) !== flow.bindingHash) {
    throw new HttpError(403, 'Este código QR pertenece a otro navegador. Generá uno nuevo desde este dispositivo.');
  }
}

function qrStartKey(req) {
  const browserHeader = String(req.get('x-niro-qr-browser') || '').trim();
  if (browserHeader) return `browser:${browserHeader.slice(0, 160)}`;
  const cookie = String(req.cookies?.[QR_FLOW_COOKIE] || '');
  if (cookie) return `cookie:${cookie}`;
  return `request:${req.ip || 'unknown'}:${String(req.get('user-agent') || '').slice(0, 160)}`;
}

function scheduleQrFlowCleanup(flowId) {
  const timer = setTimeout(async () => {
    const flow = qrLoginFlows.get(flowId);
    if (!flow) return;
    qrLoginFlows.delete(flowId);
    await whatsappQr.cancel(flowId).catch(() => {});
    if (flow.pendingOrganization) {
      await prisma.organization.deleteMany({ where: { id: flow.organizationId, active: false } }).catch(() => {});
    }
  }, QR_FLOW_TTL_MS);
  timer.unref?.();
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    mustChangePassword: user.mustChangePassword,
    permissions: require('../lib/permissions').effectivePermissions(user),
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

async function createQrFlow(req) {
  // Las pestañas del mismo navegador comparten cookies. Si una pestaña ya
  // tiene un QR vigente, reutilizarlo evita que otra pestaña reemplace la
  // cookie de vinculación y deje al primer flujo sin autorización.
  const browserCookie = String(req.cookies?.[QR_FLOW_COOKIE] || '');
  const [browserFlowId, browserBinding] = browserCookie.split('.');
  const browserFlow = browserFlowId ? qrLoginFlows.get(browserFlowId) : null;
  if (
    browserFlow
    && browserBinding
    && browserFlow.expiresAt >= Date.now()
    && hashToken(browserBinding) === browserFlow.bindingHash
  ) {
    const currentStatus = whatsappQr.getStatus(browserFlowId);
    if (currentStatus.status !== 'disconnected') {
      const currentOrganization = await prisma.organization.findUnique({
        where: { id: browserFlow.organizationId },
        select: { name: true }
      });
      const matchedOrganization = currentStatus.phone
        ? await findOrganizationByWhatsAppPhone(currentStatus.phone)
        : null;
      return {
        flowId: browserFlowId,
        binding: browserBinding,
        payload: qrPayload(browserFlowId, currentStatus, {
          setupRequired: matchedOrganization ? false : browserFlow.setupRequired,
          organizationName: matchedOrganization?.name || currentOrganization?.name || null
        })
      };
    }
  }

  // Cada inicio QR crea un espacio aislado. Recién después de leer el número
  // se decide si ese espacio se incorpora a una organización existente o si se
  // convierte en una nueva empresa. Esto evita heredar chats por accidente.
  const flowId = newFlowId();
  const binding = crypto.randomBytes(32).toString('base64url');
  const organization = await prisma.organization.create({
    data: {
      id: flowId,
      name: 'Nueva empresa Niro',
      slug: `niro-${flowId.toLowerCase()}`,
      active: false,
      settings: { create: {} }
    },
    include: { users: { where: { role: 'OWNER', active: true }, select: { id: true } } }
  });
  // The QR login is deliberately independent from the persistent organization
  // socket. This is the WhatsApp Web behavior: every browser gets a new QR and
  // cannot inherit a connected session from another browser.
  const status = await whatsappQr.start(flowId);
  // El administrador entra directamente con el QR, como en WhatsApp Web.
  // Los datos iniciales se generan automáticamente y luego pueden editarse
  // desde configuración, por lo que no se bloquea la redirección al panel.
  const setupRequired = false;
  qrLoginFlows.set(flowId, {
    organizationId: organization.id,
    pendingOrganization: true,
    setupRequired,
    bindingHash: hashToken(binding),
    expiresAt: Date.now() + QR_FLOW_TTL_MS
  });
  scheduleQrFlowCleanup(flowId);

  return {
    flowId,
    binding,
    payload: qrPayload(flowId, status, {
      setupRequired,
      organizationName: organization.name
    })
  };
}

router.post('/whatsapp/start', qrLoginLimiter, async (req, res, next) => {
  const key = qrStartKey(req);
  let pending = qrStartLocks.get(key);
  try {
    if (!pending) {
      pending = createQrFlow(req);
      qrStartLocks.set(key, pending);
    }
    const created = await pending;
    setQrFlowCookie(res, created.flowId, created.binding);
    res.json(created.payload);
  } catch (err) {
    next(err);
  } finally {
    if (qrStartLocks.get(key) === pending) qrStartLocks.delete(key);
  }
});

router.get('/whatsapp/status/:flowId', qrStatusLimiter, async (req, res, next) => {
  try {
    const flow = qrLoginFlows.get(req.params.flowId);
    if (!flow || flow.expiresAt < Date.now()) throw new HttpError(404, 'La sesión QR expiró');
    assertQrBrowser(req, req.params.flowId, flow);
    const status = whatsappQr.getStatus(req.params.flowId);
    const matchedOrganization = status.phone
      ? await findOrganizationByWhatsAppPhone(status.phone)
      : null;
    res.json(qrPayload(req.params.flowId, status, {
      setupRequired: false,
      organizationName: matchedOrganization?.name || null
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/whatsapp/complete', qrLoginLimiter, async (req, res, next) => {
  let completedFlowId = null;
  try {
    const data = whatsappQrCompleteSchema.parse(req.body);
    completedFlowId = data.flowId;
    console.log('[auth-qr] complete solicitado', { flowId: data.flowId });
    const flow = qrLoginFlows.get(data.flowId);
    if (!flow || flow.expiresAt < Date.now()) throw new HttpError(404, 'La sesión QR expiró');
    assertQrBrowser(req, data.flowId, flow);

    const status = whatsappQr.getStatus(data.flowId);
    if (status.status !== 'connected' || !status.phone) {
      throw new HttpError(409, 'Escaneá el código QR desde WhatsApp para continuar');
    }

    const phoneNumber = String(status.phone).replace(/[^0-9]/g, '');
    const pendingOrganizationId = flow.organizationId;
    const matchedOrganization = await findOrganizationByWhatsAppPhone(phoneNumber);
    const targetOrganization = matchedOrganization
      || await prisma.organization.findUnique({ where: { id: pendingOrganizationId } });
    if (!targetOrganization) throw new HttpError(404, 'No se encontró la organización de este QR');

    // Si el número ya pertenece a otra organización, el QR temporal se mueve
    // a esa organización solamente. El contenido no se copia ni se comparte.
    if (matchedOrganization && matchedOrganization.id !== pendingOrganizationId) {
      flow.organizationId = matchedOrganization.id;
      flow.pendingOrganization = false;
      flow.setupRequired = false;
      await prisma.organization.deleteMany({
        where: { id: pendingOrganizationId, active: false }
      });
    }

    const organizationId = targetOrganization.id;
    console.log('[auth-qr] QR conectado', {
      flowId: data.flowId,
      phone: phoneNumber,
      pendingOrganization: flow.pendingOrganization,
      organizationId,
      matchedOrganizationId: matchedOrganization?.id || null
    });
    const defaultCompanyName = `Niro ${phoneNumber}`;
    const defaultAdminName = `Administrador ${phoneNumber}`;
    const companyName = String(data.companyName || defaultCompanyName).trim() || defaultCompanyName;
    const adminName = String(data.adminName || defaultAdminName).trim() || defaultAdminName;
    let owner = await prisma.user.findFirst({
      where: { organizationId, role: 'OWNER', active: true },
      include: { organization: true }
    });

    if (!owner) {
      const generatedEmail = `admin.${phoneNumber}.${data.flowId.slice(-8)}@niro.local`;
      const generatedPassword = crypto.randomBytes(32).toString('base64url');
      const passwordHash = await hashPassword(generatedPassword);
      await prisma.$transaction(async (tx) => {
        await tx.organization.update({
          where: { id: organizationId },
          data: {
            name: companyName,
            active: true,
            slug: `niro-${phoneNumber}-${data.flowId.slice(-6).toLowerCase()}`,
            // 24 h de prueba desde que el teléfono se conecta (un número que vuelve reutiliza su organización: no renueva la prueba).
            trialEndsAt: new Date(Date.now() + 24 * 3600 * 1000)
          }
        });
        const createdOwner = await tx.user.create({
          data: {
            organizationId,
            name: adminName,
            email: generatedEmail,
            passwordHash,
            role: 'OWNER',
            active: true,
            mustChangePassword: false
          }
        });
        // The WhatsApp number is how a later QR login recognises this organization. Create the
        // account in the same transaction so a failure afterwards can never leave an active
        // organization that no future login can match (which spawned duplicates).
        if (!(await tx.callAccount.findFirst({ where: { organizationId } }))) {
          await tx.callAccount.create({
            data: {
              organizationId,
              name: 'WhatsApp principal',
              phoneNumber,
              status: 'CONNECTED',
              sessionReference: whatsapp.getSessionReference(organizationId),
              createdByUserId: createdOwner.id
            }
          });
        }
      });
      owner = await prisma.user.findFirst({
        where: { organizationId, role: 'OWNER', active: true },
        include: { organization: true }
      });
    }

    if (!owner) throw new HttpError(500, 'No se pudo crear el administrador de la organización');

    const account = await prisma.callAccount.findFirst({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
    const whatsappStatus = whatsapp.getStatus(organizationId);
    // Only a healthy live session keeps priority. If it is disconnected, reconnecting or revoked, the fresh
    // QR pairing (valid credentials) must replace it: discarding it left the number with no session at all.
    const shouldAttachQrSession = flow.pendingOrganization || whatsappStatus.status !== 'connected';
    console.log('[auth-qr] estado de la sesión principal', {
      flowId: data.flowId,
      status: whatsappStatus.status,
      attachQrSession: shouldAttachQrSession
    });

    if (shouldAttachQrSession) {
      console.log('[auth-qr] tomando sesión QR', { flowId: data.flowId });
      await whatsapp.adoptSession(organizationId, (dir) => whatsappQr.takeSession(data.flowId, dir));
      await whatsapp.connect(organizationId);
    } else {
      console.log('[auth-qr] cerrando flujo temporal', { flowId: data.flowId });
      await whatsappQr.cancel(data.flowId);
    }

    if (account) {
      await prisma.callAccount.update({
        where: { id: account.id },
        data: {
          // Cada QR autentica su propio navegador. Solo el QR que reconstruye
          // la sesión principal puede cambiar la línea usada por WhatsApp del
          // sistema; un navegador adicional no debe modificarla.
          phoneNumber: shouldAttachQrSession ? phoneNumber : account.phoneNumber,
          status: shouldAttachQrSession ? 'CONNECTED' : account.status,
          sessionReference: whatsapp.getSessionReference(organizationId),
          lastError: shouldAttachQrSession ? null : account.lastError
        }
      });
    } else {
      await prisma.callAccount.create({
        data: {
          organizationId,
          name: 'WhatsApp principal',
          phoneNumber,
          status: 'CONNECTED',
          sessionReference: whatsapp.getSessionReference(organizationId),
          createdByUserId: owner.id
        }
      });
    }

    console.log('[auth-qr] emitiendo sesión web', { flowId: data.flowId, userId: owner.id });
    await issueSession(res, owner, req);
    clearQrFlowCookie(res);
    await audit(prisma, {
      organizationId: owner.organizationId,
      actorUserId: owner.id,
      action: 'auth.whatsapp_qr.success',
      entityType: 'User',
      entityId: owner.id,
      metadata: { phoneNumber }
    });
    qrLoginFlows.delete(data.flowId);
    console.log('[auth-qr] complete exitoso', { flowId: data.flowId, userId: owner.id });
    res.json({ user: sanitizeUser(owner), phone: phoneNumber });
  } catch (err) {
    console.error('[auth-qr] complete falló', {
      flowId: completedFlowId,
      name: err?.name,
      message: err?.message,
      stack: err?.stack
    });
    next(err);
  }
});

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

    // Two tabs (or the HTTP client and the socket) can legitimately present the same
    // cookie within moments of each other: the loser of the race must not be treated as
    // token theft, otherwise every session of the user is revoked.
    const REFRESH_REUSE_GRACE_MS = 15 * 1000;
    if (stored.revokedAt && stored.replacedByHash && Date.now() - stored.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
      throw new HttpError(409, 'La sesión se está renovando, reintentá');
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
