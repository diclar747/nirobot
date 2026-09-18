async function audit(prisma, { organizationId = null, actorUserId = null, action, entityType, entityId = null, metadata = null }) {
  await prisma.auditLog.create({
    data: { organizationId, actorUserId, action, entityType, entityId, metadata }
  });
}

module.exports = { audit };
