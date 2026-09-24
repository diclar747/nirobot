// Panel de Grupos: guarda en la base los grupos de WhatsApp y sus integrantes para verlos, filtrarlos y exportarlos.
const { prisma } = require('./prisma');
const whatsapp = require('./whatsapp');

const syncing = new Set();

async function syncGroups(organizationId, { onProgress } = {}) {
  if (syncing.has(organizationId)) return { skipped: true };
  syncing.add(organizationId);
  try {
    const groups = await whatsapp.fetchGroupsDetailed(organizationId);
    // Nombres ya conocidos por Niro (contactos guardados) para no dejar "solo el número" cuando WhatsApp no entrega el nombre del participante.
    const phones = [...new Set(groups.flatMap((g) => g.members.map((m) => m.phone)).filter(Boolean))];
    const known = phones.length ? await prisma.contact.findMany({ where: { organizationId, phone: { in: phones }, name: { not: null } }, select: { phone: true, name: true } }) : [];
    const knownNames = new Map(known.map((c) => [c.phone, c.name]));
    for (const group of groups) for (const member of group.members) if (!member.name && member.phone && knownNames.has(member.phone)) member.name = knownNames.get(member.phone);

    const now = new Date();
    const keep = groups.map((g) => g.jid);
    let processed = 0;
    if (onProgress) await onProgress({ total: groups.length, processed });
    for (const group of groups) {
      const { members, ...fields } = group;
      const saved = await prisma.whatsappGroup.upsert({
        where: { organizationId_jid: { organizationId, jid: group.jid } },
        create: { organizationId, ...fields, size: members.length, syncedAt: now },
        update: { ...fields, size: members.length, syncedAt: now }
      });
      const unique = [...new Map(members.map((m) => [m.jid, m])).values()];
      // Upsert por integrante (no borrar y recrear): así no se pierde el avatarUrl ya descargado en una sincronización anterior.
      await prisma.$transaction([
        prisma.whatsappGroupMember.deleteMany({ where: { groupId: saved.id, jid: { notIn: unique.map((m) => m.jid) } } }),
        ...unique.map((m) => prisma.whatsappGroupMember.upsert({
          where: { groupId_jid: { groupId: saved.id, jid: m.jid } },
          create: { groupId: saved.id, ...m },
          update: { lid: m.lid, phone: m.phone, name: m.name, role: m.role, isSelf: m.isSelf }
        }))
      ]);
      processed += 1;
      if (onProgress) await onProgress({ total: groups.length, processed });
    }
    await prisma.whatsappGroup.deleteMany({ where: { organizationId, jid: { notIn: keep } } });
    return { groups: groups.length, members: groups.reduce((sum, g) => sum + g.members.length, 0) };
  } finally {
    syncing.delete(organizationId);
  }
}

module.exports = { syncGroups };
