const express = require('express');
const { prisma } = require('../lib/prisma');
const { requirePermission } = require('../lib/permissions');
const { requireAuth, requireCsrf } = require('../middleware/auth');
const { HttpError } = require('../lib/errors');
const { syncGroups } = require('../lib/whatsappGroups');
const { resolvePath } = require('../lib/storage');

const router = express.Router();

router.use(requireAuth, (req, _res, next) => (req.auth.organizationId ? next() : next(new HttpError(403, 'Esta acción requiere pertenecer a una organización'))));
router.use(requirePermission('groups'));

// `avatarUrl` guarda la storageKey ("orgId/archivo") de la foto ya descargada — nunca el link
// crudo de WhatsApp (vence a las pocas horas). Datos viejos de antes de este cambio todavía
// pueden tener ese link puesto; se tratan como "sin foto" hasta que la sincronización los
// reemplace por una storageKey.
function avatarUrlFor(key) {
  if (!key || /^https?:\/\//i.test(key)) return null;
  return `/api/org/groups/avatar/${key}`;
}

function sanitizeMember(m) {
  return { id: m.id, name: m.name, phone: m.phone, lid: m.lid, role: m.role, isSelf: m.isSelf, phoneKnown: Boolean(m.phone), avatarUrl: avatarUrlFor(m.avatarUrl) };
}

function sanitizeGroup(g, extra = {}) {
  return { id: g.id, jid: g.jid, name: g.name, description: g.description, ownerPhone: g.ownerPhone, groupCreatedAt: g.groupCreatedAt, announce: g.announce, size: g.size, syncedAt: g.syncedAt, avatarUrl: avatarUrlFor(g.avatarUrl), ...extra };
}

// Sirve la foto ya descargada de un grupo o integrante. La storageKey siempre empieza con el id
// de la organización, así que alcanza con comparar contra la del pedido — no hace falta ir a
// buscar a qué grupo/integrante pertenece.
router.get('/avatar/:orgId/:file', (req, res, next) => {
  if (req.params.orgId !== req.auth.organizationId) return next(new HttpError(404, 'Imagen no encontrada'));
  let filePath;
  try {
    filePath = resolvePath(`${req.params.orgId}/${req.params.file}`);
  } catch {
    return next(new HttpError(404, 'Imagen no encontrada'));
  }
  res.sendFile(filePath, (err) => { if (err && !res.headersSent) next(new HttpError(404, 'Imagen no encontrada')); });
});

// Lista de grupos + resumen para el dashboard.
router.get('/', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const q = String(req.query.q || '').trim();
    const groups = await prisma.whatsappGroup.findMany({
      where: { organizationId, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { members: { some: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q.replace(/\D/g, '') || '__none__' } }] } } }] } : {}) },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } }, members: { where: { OR: [{ role: { not: null } }, { phone: null }] }, select: { role: true, phone: true } } }
    });
    const rows = groups.map((g) => sanitizeGroup(g, {
      admins: g.members.filter((m) => m.role).length,
      unidentified: g.members.filter((m) => !m.phone).length,
      memberCount: g._count.members
    }));
    const [totalGroups, totalMembers, uniquePhones, admins, unidentified, latest] = await Promise.all([
      prisma.whatsappGroup.count({ where: { organizationId } }),
      prisma.whatsappGroupMember.count({ where: { group: { organizationId } } }),
      prisma.whatsappGroupMember.findMany({ where: { group: { organizationId }, phone: { not: null } }, distinct: ['phone'], select: { phone: true } }),
      prisma.whatsappGroupMember.count({ where: { group: { organizationId }, role: { not: null } } }),
      prisma.whatsappGroupMember.count({ where: { group: { organizationId }, phone: null } }),
      prisma.whatsappGroup.findFirst({ where: { organizationId }, orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } })
    ]);
    res.json({ groups: rows, stats: { groups: totalGroups, memberships: totalMembers, uniqueMembers: uniquePhones.length, admins, unidentified, syncedAt: latest ? latest.syncedAt : null } });
  } catch (err) { next(err); }
});

router.get('/:id/members', async (req, res, next) => {
  try {
    const group = await prisma.whatsappGroup.findFirst({ where: { id: req.params.id, organizationId: req.auth.organizationId } });
    if (!group) throw new HttpError(404, 'Grupo no encontrado');
    const members = await prisma.whatsappGroupMember.findMany({ where: { groupId: group.id }, orderBy: [{ role: 'asc' }, { name: 'asc' }] });
    const order = { superadmin: 0, admin: 1 };
    members.sort((a, b) => (order[a.role] ?? 2) - (order[b.role] ?? 2) || String(a.name || a.phone || '~').localeCompare(String(b.name || b.phone || '~')));
    res.json({ group: sanitizeGroup(group), members: members.map(sanitizeMember) });
  } catch (err) { next(err); }
});

// Baja de nuevo los grupos desde WhatsApp.
router.post('/sync', requireCsrf, async (req, res, next) => {
  try {
    if (!(await require('../lib/whatsappSync').isEnabled(req.auth.organizationId, 'groups'))) {
      throw new HttpError(403, 'Activá “Descargar grupos” en Configuración → Sincronización con WhatsApp para importar tus grupos.');
    }
    const result = await syncGroups(req.auth.organizationId);
    res.json({ ok: true, ...result });
  } catch (err) { next(err.status ? new HttpError(err.status, err.message) : err); }
});

function csvEscape(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) && !/^\+\d+$/.test(text) ? `'${text}` : text; // evita inyección de fórmulas en Excel
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// scope=groups → un renglón por grupo · scope=members → un renglón por integrante (todos, o de ?groupId=).
router.get('/export.csv', async (req, res, next) => {
  try {
    const organizationId = req.auth.organizationId;
    const scope = req.query.scope === 'groups' ? 'groups' : 'members';
    const onlyWithPhone = req.query.onlyWithPhone === '1';
    const phoneText = (p) => (p ? `+${p}` : '');
    const lines = [];
    let name = 'grupos';
    if (scope === 'groups') {
      const groups = await prisma.whatsappGroup.findMany({ where: { organizationId }, orderBy: { name: 'asc' } });
      lines.push('Grupo,ID del grupo,Integrantes,Creador,Creado,Solo admins escriben,Descripción');
      for (const g of groups) lines.push([g.name, g.jid, g.size, phoneText(g.ownerPhone), g.groupCreatedAt ? g.groupCreatedAt.toISOString() : '', g.announce ? 'Sí' : 'No', g.description].map(csvEscape).join(','));
    } else {
      const groupId = req.query.groupId ? String(req.query.groupId) : null;
      const groups = await prisma.whatsappGroup.findMany({
        where: { organizationId, ...(groupId ? { id: groupId } : {}) },
        orderBy: { name: 'asc' },
        include: { members: { where: onlyWithPhone ? { phone: { not: null } } : {}, orderBy: { name: 'asc' } } }
      });
      if (groupId && groups.length === 0) throw new HttpError(404, 'Grupo no encontrado');
      if (groupId) name = `grupo-${groups[0].name.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40)}`;
      lines.push('Grupo,Nombre,Teléfono,Rol,Estado del número,Identificador (LID)');
      for (const g of groups) {
        for (const m of g.members) lines.push([g.name, m.name, phoneText(m.phone), m.role === 'superadmin' ? 'Creador' : m.role === 'admin' ? 'Administrador' : 'Integrante', m.phone ? 'Identificado' : 'Pendiente de identificar', m.lid].map(csvEscape).join(','));
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${lines.join('\r\n')}`);
  } catch (err) { next(err); }
});

module.exports = router;
