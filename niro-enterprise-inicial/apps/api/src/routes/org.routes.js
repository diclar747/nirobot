const express = require('express');
const { prisma } = require('../lib/prisma');
const { hashPassword, generateTemporaryPassword } = require('../lib/passwords');
const { audit } = require('../lib/audit');
const whatsapp = require('../lib/whatsapp');
const { requireAuth, requireRole, requireCsrf, requireOrgContext } = require('../middleware/auth');
const {
  updateOrgProfileSchema,
  updateOrgSettingsSchema,
  createUserSchema,
  updateUserSchema,
  departmentSchema,
  updateDepartmentSchema,
  addMemberSchema
} = require('../validation/org.validation');
const { HttpError } = require('../lib/errors');
const { contactAvatarUrlFor } = require('../lib/avatars');

const router = express.Router();

router.use(requireAuth, requireOrgContext);

function sanitizeOrgUser(user, whatsappProfile = null) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    autoChat: Boolean(user.autoChat),
    createdAt: user.createdAt,
    permissions: require('../lib/permissions').effectivePermissions(user),
    departments: (user.memberships || []).map((m) => ({ id: m.department.id, name: m.department.name })),
    whatsapp: whatsappProfile
  };
}

// Reemplaza las áreas (departamentos) de un usuario por la lista indicada.
async function setUserDepartments(organizationId, userId, departmentIds) {
  const unique = Array.from(new Set(departmentIds));
  const valid = unique.length ? await prisma.department.findMany({ where: { organizationId, id: { in: unique } }, select: { id: true } }) : [];
  if (valid.length !== unique.length) throw new HttpError(404, 'Alguna de las áreas elegidas ya no existe');
  await prisma.$transaction([
    prisma.departmentMember.deleteMany({ where: { userId, department: { organizationId } } }),
    ...(valid.length ? [prisma.departmentMember.createMany({ data: valid.map((d) => ({ departmentId: d.id, userId })), skipDuplicates: true })] : [])
  ]);
  require('../lib/chatAccess').invalidateAgentCache(organizationId);
}

function sanitizeSettings(settings) {
  return {
    welcomeMessage: settings.welcomeMessage,
    systemPrompt: settings.systemPrompt,
    aiEnabled: settings.aiEnabled,
    autoTranscribeAudio: Boolean(settings.autoTranscribeAudio),
    niroAiConfigured: require('../lib/niroAi').isConfigured(),
    menuOptions: settings.menuOptions,
    botFlow: settings.botFlow || null
  };
}

async function getOwnOrg(organizationId) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { settings: true, _count: { select: { users: true } } }
  });
  if (!organization) throw new HttpError(404, 'Organización no encontrada');
  return organization;
}

router.get('/permissions', (_req, res) => {
  res.json({ permissions: require('../lib/permissions').PERMISSIONS });
});

router.get('/', async (req, res, next) => {
  try {
    const organization = await getOwnOrg(req.auth.organizationId);
    res.json({
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        planTier: organization.planTier,
        maxUsers: organization.maxUsers,
        userCount: organization._count.users,
        seats: await require('../lib/billing').seatInfo(organization.id),
        settings: organization.settings ? sanitizeSettings(organization.settings) : null
      }
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/', requireRole('OWNER'), requireCsrf, async (req, res, next) => {
  try {
    const data = updateOrgProfileSchema.parse(req.body);
    const organization = await prisma.organization.update({ where: { id: req.auth.organizationId }, data });
    await audit(prisma, {
      organizationId: organization.id,
      actorUserId: req.auth.userId,
      action: 'organization.profile.updated',
      entityType: 'Organization',
      entityId: organization.id,
      metadata: data
    });
    res.json({ organization: { id: organization.id, name: organization.name, slug: organization.slug } });
  } catch (err) {
    next(err);
  }
});

router.patch('/settings', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const data = updateOrgSettingsSchema.parse(req.body);

    if (data.menuOptions) {
      const deptIds = [...new Set(data.menuOptions.map((o) => o.departmentId))];
      const found = await prisma.department.count({ where: { id: { in: deptIds }, organizationId: req.auth.organizationId } });
      if (found !== deptIds.length) throw new HttpError(404, 'Uno de los departamentos del menú no existe');
      const keys = data.menuOptions.map((o) => o.key);
      if (new Set(keys).size !== keys.length) throw new HttpError(400, 'Las opciones del menú no pueden repetir la misma clave');
    }

    const settings = await prisma.organizationSettings.update({
      where: { organizationId: req.auth.organizationId },
      data
    });
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'organization.settings.updated',
      entityType: 'OrganizationSettings',
      entityId: settings.id,
      metadata: data
    });
    res.json({ settings: sanitizeSettings(settings) });
  } catch (err) {
    next(err);
  }
});

// --- Usuarios ---

router.get('/users', requireRole('OWNER', 'ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  try {
    const [users, callAccount] = await Promise.all([
      prisma.user.findMany({
        where: { organizationId: req.auth.organizationId },
        include: { memberships: { include: { department: { select: { id: true, name: true } } } } },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.callAccount.findFirst({
        where: { organizationId: req.auth.organizationId },
        orderBy: { createdAt: 'asc' },
        select: { phoneNumber: true }
      })
    ]);
    const status = whatsapp.getStatus(req.auth.organizationId);
    const whatsappProfile = {
      name: status.profileName || null,
      phone: status.phone || callAccount?.phoneNumber || null,
      avatarUrl: status.avatarUrl || null
    };
    res.json({
      users: users.map((user) => sanitizeOrgUser(user, user.role === 'OWNER' ? whatsappProfile : null))
    });
  } catch (err) {
    next(err);
  }
});

function loginUrl() {
  const origin = (process.env.PUBLIC_APP_URL || String(process.env.WEB_ORIGIN || '').split(',')[0] || '').trim().replace(/\/$/, '');
  return origin ? `${origin}/login` : '';
}

// Bienvenida por WhatsApp al crear un usuario con teléfono: nunca hace fallar la creación —
// si WhatsApp no está conectado o el envío falla, se informa en la respuesta y el admin puede
// pasarle los datos a mano.
async function sendWelcomeWhatsApp(organizationId, organization, { name, email, phone }, temporaryPassword) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const url = loginUrl();
  const lines = [
    `👋 ¡Hola${first ? ` ${first}` : ''}! Bienvenido/a a *Niro* 🎉`,
    '',
    `Ya tenés tu cuenta de acceso como agente de *${organization.name}*:`,
    '',
    `📧 Usuario: ${email}`,
    `🔑 Contraseña: ${temporaryPassword}`,
    url ? `🔗 Ingresá acá: ${url}` : null,
    '',
    'Te va a pedir cambiarla la primera vez que entres. ¡Éxitos! 🚀'
  ].filter((line) => line !== null);
  try {
    await whatsapp.sendText(organizationId, phone, lines.join('\n'));
    return { sent: true };
  } catch (err) {
    console.warn('[org] no se pudo enviar la bienvenida por WhatsApp:', err.message || err);
    return { sent: false, error: err.message || 'No se pudo enviar el WhatsApp' };
  }
}

router.post('/users', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const data = createUserSchema.parse(req.body);

    if (data.role === 'OWNER' && req.auth.role !== 'OWNER') {
      throw new HttpError(403, 'Solo un propietario puede crear otro propietario');
    }

    const organization = await getOwnOrg(req.auth.organizationId);
    await require('../lib/billing').assertCanAddUser(organization.id);

    const temporaryPassword = data.password || generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    let user;
    try {
      user = await prisma.user.create({
        data: {
          organizationId: req.auth.organizationId,
          name: data.name,
          email: data.email,
          phone: data.phone || null,
          role: data.role,
          passwordHash,
          mustChangePassword: true,
          autoChat: data.role === 'AGENT' && data.autoChat === true
        }
      });
    } catch (err) {
      if (err.code === 'P2002') throw new HttpError(409, 'Ese email ya está en uso');
      throw err;
    }

    if (data.departmentIds && data.departmentIds.length > 0) await setUserDepartments(req.auth.organizationId, user.id, data.departmentIds);
    require('../lib/chatAccess').invalidateAgentCache(req.auth.organizationId);

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'user.created',
      entityType: 'User',
      entityId: user.id,
      metadata: { role: data.role, email: data.email }
    });

    const whatsappWelcome = data.phone
      ? await sendWelcomeWhatsApp(req.auth.organizationId, organization, { name: data.name, email: data.email, phone: data.phone }, temporaryPassword)
      : null;

    const withAreas = await prisma.user.findUnique({ where: { id: user.id }, include: { memberships: { include: { department: { select: { id: true, name: true } } } } } });
    res.status(201).json({ user: sanitizeOrgUser(withAreas || user), temporaryPassword: data.password ? undefined : temporaryPassword, whatsappWelcome });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const parsed = updateUserSchema.parse(req.body);
    const departmentIds = parsed.departmentIds;
    delete parsed.departmentIds;
    const data = parsed;
    const target = await prisma.user.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!target) throw new HttpError(404, 'Usuario no encontrado');

    const touchesOwnerRole = data.role === 'OWNER' || target.role === 'OWNER';
    if (touchesOwnerRole && req.auth.role !== 'OWNER') {
      throw new HttpError(403, 'Solo un propietario puede modificar a otro propietario');
    }
    if (target.id === req.auth.userId && data.active === false) {
      throw new HttpError(400, 'No podés desactivar tu propia cuenta');
    }
    if (target.role === 'OWNER' && (data.active === false || (data.role && data.role !== 'OWNER'))) {
      const activeOwners = await prisma.user.count({
        where: { organizationId: req.auth.organizationId, role: 'OWNER', active: true }
      });
      if (activeOwners <= 1) throw new HttpError(400, 'Debe existir al menos un propietario activo');
    }

    // Permisos: solo se editan en supervisores y agentes; propietario y administrador siempre tienen todo.
    if (typeof data.permissions !== 'undefined') {
      const perms = require('../lib/permissions');
      const finalRole = data.role || target.role;
      if (!perms.isRestrictable(finalRole)) throw new HttpError(400, 'Los administradores siempre tienen todos los permisos');
      data.permissions = perms.normalizePermissionsInput(data.permissions) || {};
      // Guardamos solo las restricciones (false); lo demás queda activo por defecto.
      data.permissions = Object.fromEntries(Object.entries(data.permissions).filter(([, v]) => v === false));
    }
    if (data.role && !require('../lib/permissions').isRestrictable(data.role)) data.permissions = {};

    // Reactivar a un usuario también ocupa un puesto del plan.
    if (data.active === true && target.active === false) await require('../lib/billing').assertCanAddUser(req.auth.organizationId);

    const user = await prisma.user.update({ where: { id: target.id }, data, include: { memberships: { include: { department: { select: { id: true, name: true } } } } } });
    if (departmentIds) {
      await setUserDepartments(req.auth.organizationId, target.id, departmentIds);
      user.memberships = (await prisma.departmentMember.findMany({ where: { userId: target.id }, include: { department: { select: { id: true, name: true } } } }));
    }
    require('../lib/chatAccess').invalidateAgentCache(req.auth.organizationId);
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'user.updated',
      entityType: 'User',
      entityId: user.id,
      metadata: data
    });
    res.json({ user: sanitizeOrgUser(user) });
  } catch (err) {
    next(err);
  }
});

router.delete('/users/:id', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const target = await prisma.user.findFirst({ where: { id: req.params.id, organizationId } });
    if (!target) throw new HttpError(404, 'Usuario no encontrado');
    if (target.id === req.auth.userId) throw new HttpError(400, 'No podés eliminar tu propia cuenta');
    if (target.role === 'OWNER') {
      if (req.auth.role !== 'OWNER') throw new HttpError(403, 'Solo un propietario puede eliminar a otro propietario');
      const otherOwners = await prisma.user.count({ where: { organizationId, role: 'OWNER', active: true, id: { not: target.id } } });
      if (otherOwners === 0) throw new HttpError(400, 'Debe existir al menos un propietario activo');
    }
    // Sus chats, mensajes y campañas quedan en la cuenta (las referencias al usuario pasan a "sin asignar").
    await prisma.$transaction([
      prisma.refreshToken.deleteMany({ where: { userId: target.id } }),
      prisma.user.delete({ where: { id: target.id } })
    ]);
    require('../lib/chatAccess').invalidateAgentCache(organizationId);
    await audit(prisma, {
      organizationId,
      actorUserId: req.auth.userId,
      action: 'user.deleted',
      entityType: 'User',
      entityId: target.id,
      metadata: { email: target.email, name: target.name, role: target.role }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/reset-password', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const target = await prisma.user.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!target) throw new HttpError(404, 'Usuario no encontrado');
    if (target.role === 'OWNER' && req.auth.role !== 'OWNER') {
      throw new HttpError(403, 'Solo un propietario puede resetear la contraseña de otro propietario');
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { passwordHash, mustChangePassword: true } }),
      prisma.refreshToken.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } })
    ]);

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'user.password.reset',
      entityType: 'User',
      entityId: target.id
    });

    res.json({ temporaryPassword });
  } catch (err) {
    next(err);
  }
});

// --- Departamentos ---

router.get('/departments', async (req, res, next) => {
  try {
    const departments = await prisma.department.findMany({
      where: { organizationId: req.auth.organizationId },
      include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
      orderBy: { createdAt: 'asc' }
    });
    res.json({
      departments: departments.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        members: d.members.map((m) => m.user)
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.post('/departments', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const data = departmentSchema.parse(req.body);
    let department;
    try {
      department = await prisma.department.create({ data: { ...data, organizationId: req.auth.organizationId } });
    } catch (err) {
      if (err.code === 'P2002') throw new HttpError(409, 'Ya existe un departamento con ese nombre');
      throw err;
    }
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'department.created',
      entityType: 'Department',
      entityId: department.id,
      metadata: data
    });
    res.status(201).json({ department });
  } catch (err) {
    next(err);
  }
});

router.patch('/departments/:id', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const data = updateDepartmentSchema.parse(req.body);
    const existing = await prisma.department.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!existing) throw new HttpError(404, 'Departamento no encontrado');

    let department;
    try {
      department = await prisma.department.update({ where: { id: existing.id }, data });
    } catch (err) {
      if (err.code === 'P2002') throw new HttpError(409, 'Ya existe un departamento con ese nombre');
      throw err;
    }
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'department.updated',
      entityType: 'Department',
      entityId: department.id,
      metadata: data
    });
    res.json({ department });
  } catch (err) {
    next(err);
  }
});

router.delete('/departments/:id', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.department.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!existing) throw new HttpError(404, 'Departamento no encontrado');

    await prisma.department.delete({ where: { id: existing.id } });
    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'department.deleted',
      entityType: 'Department',
      entityId: existing.id
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/departments/:id/members', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const { userId } = addMemberSchema.parse(req.body);
    const [department, user] = await Promise.all([
      prisma.department.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } }),
      prisma.user.findFirst({ where: { id: userId, organizationId: req.auth.organizationId } })
    ]);
    if (!department) throw new HttpError(404, 'Departamento no encontrado');
    if (!user) throw new HttpError(404, 'Usuario no encontrado');

    try {
      await prisma.departmentMember.create({ data: { departmentId: department.id, userId: user.id } });
      require('../lib/chatAccess').invalidateAgentCache(req.auth.organizationId);
    } catch (err) {
      if (err.code === 'P2002') throw new HttpError(409, 'El usuario ya pertenece a ese departamento');
      throw err;
    }

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'department.member.added',
      entityType: 'Department',
      entityId: department.id,
      metadata: { userId: user.id }
    });
    res.status(201).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/departments/:id/members/:userId', requireRole('OWNER', 'ADMIN'), requireCsrf, async (req, res, next) => {
  try {
    const department = await prisma.department.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!department) throw new HttpError(404, 'Departamento no encontrado');

    const deleted = await prisma.departmentMember.deleteMany({
      where: { departmentId: department.id, userId: req.params.userId }
    });
    if (deleted.count === 0) throw new HttpError(404, 'El usuario no pertenece a ese departamento');
    require('../lib/chatAccess').invalidateAgentCache(req.auth.organizationId);

    await audit(prisma, {
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      action: 'department.member.removed',
      entityType: 'Department',
      entityId: department.id,
      metadata: { userId: req.params.userId }
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const { getOrgPresenceList, setAgentPresenceStatus, PRESENCE_STATUSES } = require('../lib/realtime');

router.get('/presence', async (req, res, next) => {
  try {
    const list = getOrgPresenceList(req.auth.organizationId);
    res.json({ presence: list });
  } catch (err) {
    next(err);
  }
});

router.post('/presence/status', requireCsrf, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!PRESENCE_STATUSES.includes(status)) {
      throw new HttpError(400, 'Estado no válido');
    }
    // Sin una pestaña conectada no hay presencia que cambiar: se recuerda igual para cuando se conecte.
    const applied = setAgentPresenceStatus(req.auth.organizationId, req.auth.userId, status);
    res.json({ ok: true, status, applied });
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard-stats', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const now = new Date();
    const PY_OFFSET_MS = -3 * 60 * 60 * 1000; // America/Asuncion (UTC-3)
    const pyNow = new Date(now.getTime() + PY_OFFSET_MS);
    const startOfToday = new Date(Date.UTC(pyNow.getUTCFullYear(), pyNow.getUTCMonth(), pyNow.getUTCDate()) - PY_OFFSET_MS);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalMessages,
      todayMessages,
      inboundMessages,
      outboundMessages,
      botMessages,
      noteMessages,
      conversationsByStatus,
      unassignedConversationsCount,
      conversationsByChannel,
      recentUnassigned,
      ordersByStatus,
      allOrders,
      todayOrders,
      departments,
      users,
      settings,
      recentConversationsWithFirstResponse,
      last7DaysMessages
    ] = await Promise.all([
      prisma.message.count({ where: { conversation: { organizationId } } }),
      prisma.message.count({ where: { conversation: { organizationId }, createdAt: { gte: startOfToday } } }),
      prisma.message.count({ where: { conversation: { organizationId }, direction: 'INBOUND' } }),
      prisma.message.count({ where: { conversation: { organizationId }, direction: 'OUTBOUND' } }),
      prisma.message.count({ where: { conversation: { organizationId }, direction: 'OUTBOUND', senderUserId: null } }),
      prisma.message.count({ where: { conversation: { organizationId }, direction: 'NOTE' } }),
      prisma.conversation.groupBy({ by: ['status'], where: { organizationId }, _count: true }),
      prisma.conversation.count({ where: { organizationId, assignedToId: null, status: { in: ['OPEN', 'PENDING'] } } }),
      prisma.conversation.groupBy({ by: ['channel'], where: { organizationId }, _count: true }),
      prisma.conversation.findMany({
        where: { organizationId, assignedToId: null, status: { in: ['OPEN', 'PENDING'] } },
        include: {
          contact: true,
          department: { select: { id: true, name: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 }
        },
        orderBy: { updatedAt: 'desc' },
        take: 6
      }),
      prisma.order.groupBy({ by: ['status'], where: { organizationId }, _count: true }),
      prisma.order.findMany({
        where: { organizationId, status: { not: 'CANCELLED' } },
        select: { items: { select: { quantity: true, unitPrice: true } } }
      }),
      prisma.order.findMany({
        where: { organizationId, createdAt: { gte: startOfToday }, status: { not: 'CANCELLED' } },
        select: { items: { select: { quantity: true, unitPrice: true } } }
      }),
      prisma.department.findMany({
        where: { organizationId },
        include: { _count: { select: { conversations: true, members: true } } }
      }),
      prisma.user.findMany({
        where: { organizationId, active: true },
        select: { id: true, name: true, email: true, role: true }
      }),
      prisma.organizationSettings.findUnique({ where: { organizationId } }),
      prisma.conversation.findMany({
        where: { organizationId, createdAt: { gte: sevenDaysAgo } },
        select: {
          id: true,
          createdAt: true,
          messages: {
            where: { direction: 'OUTBOUND', senderUserId: { not: null } },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { createdAt: true }
          }
        }
      }),
      prisma.message.findMany({
        where: { conversation: { organizationId }, createdAt: { gte: sevenDaysAgo } },
        select: { createdAt: true, direction: true }
      })
    ]);

    // Calculate revenue
    const revenueTotal = allOrders.reduce(
      (sum, ord) => sum + ord.items.reduce((s, i) => s + Number(i.unitPrice || 0) * i.quantity, 0),
      0
    );
    const revenueToday = todayOrders.reduce(
      (sum, ord) => sum + ord.items.reduce((s, i) => s + Number(i.unitPrice || 0) * i.quantity, 0),
      0
    );

    // Calculate response time
    const responseSamples = recentConversationsWithFirstResponse
      .filter((c) => c.messages.length > 0)
      .map((c) => (c.messages[0].createdAt.getTime() - c.createdAt.getTime()) / 60000);
    const avgFirstResponseMinutes =
      responseSamples.length > 0 ? Math.round(responseSamples.reduce((a, b) => a + b, 0) / responseSamples.length) : null;

    // Response rate
    const agentOutbound = outboundMessages - botMessages;
    const responseRate = inboundMessages > 0 ? Math.min(100, Math.round((agentOutbound / inboundMessages) * 100)) : null;

    // Status map
    const convStatusMap = Object.fromEntries(conversationsByStatus.map((s) => [s.status, s._count]));
    const orderStatusMap = Object.fromEntries(ordersByStatus.map((s) => [s.status, s._count]));

    const totalConversations = Object.values(convStatusMap).reduce((a, b) => a + b, 0);
    const totalOrdersCount = Object.values(orderStatusMap).reduce((a, b) => a + b, 0);

    // Daily activity for last 7 days
    const daysMap = new Map();
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      daysMap.set(key, {
        date: key,
        dayName: dayNames[d.getDay()],
        inbound: 0,
        outbound: 0,
        total: 0
      });
    }

    for (const msg of last7DaysMessages) {
      const key = msg.createdAt.toISOString().slice(0, 10);
      if (daysMap.has(key)) {
        const item = daysMap.get(key);
        if (msg.direction === 'INBOUND') item.inbound += 1;
        else if (msg.direction === 'OUTBOUND') item.outbound += 1;
        item.total += 1;
      }
    }

    // Presence list
    const presenceList = getOrgPresenceList(organizationId);
    const onlineUserIds = new Set(presenceList.map((p) => p.userId));
    const fullAgentList = users.map((u) => {
      const pres = presenceList.find((p) => p.userId === u.id);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        online: onlineUserIds.has(u.id),
        status: pres ? pres.status : 'offline'
      };
    });

    const onlineCount = fullAgentList.filter((a) => a.online).length;
    const availableCount = fullAgentList.filter((a) => a.status === 'available').length;
    const busyCount = fullAgentList.filter((a) => a.status === 'busy').length;
    const awayCount = fullAgentList.filter((a) => a.status === 'away').length;
    const offlineCount = fullAgentList.length - onlineCount;

    res.json({
      kpis: {
        messages: {
          total: totalMessages,
          today: todayMessages,
          inbound: inboundMessages,
          outbound: outboundMessages,
          notes: noteMessages,
          bot: botMessages,
          responseRate,
          avgFirstResponseMinutes
        },
        conversations: {
          total: totalConversations,
          open: convStatusMap.OPEN || 0,
          pending: convStatusMap.PENDING || 0,
          resolved: convStatusMap.RESOLVED || 0,
          closed: convStatusMap.CLOSED || 0,
          unassigned: unassignedConversationsCount,
          activeClients: convStatusMap.OPEN || 0,
          pendingClients: unassignedConversationsCount + (convStatusMap.PENDING || 0),
          followingClients: Math.max(0, (convStatusMap.OPEN || 0) - unassignedConversationsCount),
          resolvedClients: (convStatusMap.RESOLVED || 0) + (convStatusMap.CLOSED || 0)
        },
        orders: {
          total: totalOrdersCount,
          received: orderStatusMap.RECEIVED || 0,
          confirmed: orderStatusMap.CONFIRMED || 0,
          preparing: orderStatusMap.PREPARING || 0,
          dispatched: orderStatusMap.DISPATCHED || 0,
          delivered: orderStatusMap.DELIVERED || 0,
          cancelled: orderStatusMap.CANCELLED || 0,
          pending: (orderStatusMap.RECEIVED || 0) + (orderStatusMap.CONFIRMED || 0) + (orderStatusMap.PREPARING || 0),
          revenueTotal,
          revenueToday
        },
        bot: {
          active: Boolean(settings?.botFlow?.enabled && settings?.botFlow?.published),
          welcomeMessage: settings?.welcomeMessage || '',
          systemPrompt: settings?.systemPrompt || '',
          menuCount: Array.isArray(settings?.menuOptions) ? settings.menuOptions.length : 0
        },
        agents: {
          total: users.length,
          onlineCount,
          availableCount,
          busyCount,
          awayCount,
          offlineCount,
          list: fullAgentList
        }
      },
      recentUnassigned: recentUnassigned.map((c) => ({
        id: c.id,
        subject: c.subject,
        channel: c.channel,
        status: c.status,
        priority: c.priority,
        updatedAt: c.updatedAt,
        contact: {
          id: c.contact.id,
          name: c.contact.name,
          phone: c.contact.phone,
          email: c.contact.email,
          avatarUrl: contactAvatarUrlFor(c.contact.avatarUrl)
        },
        department: c.department ? { id: c.department.id, name: c.department.name } : null,
        lastMessage: c.messages[0]?.content || null
      })),
      dailyActivity: Array.from(daysMap.values()),
      departments: departments.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        conversationsCount: d._count.conversations,
        membersCount: d._count.members
      })),
      channels: conversationsByChannel.map((c) => ({ channel: c.channel, count: c._count }))
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
