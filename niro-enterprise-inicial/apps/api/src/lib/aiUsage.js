// Registro y resumen del uso de la API de Niro IA por organización. Cada llamada exitosa a
// niroAi.js pasa por acá una vez, para que la interfaz pueda mostrar cuánto se está usando el
// asistente sin tener que ir a consultar /wallet en la plataforma de Niro IA.
const { prisma } = require('./prisma');

const KINDS = {
  CHAT: 'chat',
  CHAT_TEST: 'chat_test',
  AGENT_CHAT: 'agent_chat',
  TRANSCRIPTION: 'transcription',
  SPEECH: 'speech',
  VISION: 'vision',
  DOCUMENT: 'document'
};

const KIND_LABEL = {
  chat: 'Respuestas del bot',
  chat_test: 'Pruebas en Ajustes',
  agent_chat: 'Chat con agentes',
  transcription: 'Transcripción de audio',
  vision: 'Lectura de imágenes/facturas',
  document: 'Análisis de documentos'
};

/** Nunca debe romper el flujo que la llamó: registrar el uso es best-effort. */
async function recordAiUsage(organizationId, kind, cost) {
  if (!organizationId) return;
  try {
    await prisma.aiUsageLog.create({
      data: { organizationId, kind, cost: cost === null || cost === undefined ? null : cost }
    });
  } catch (err) {
    console.error('[ai-usage] no se pudo registrar el uso de IA:', err.message || err);
  }
}

async function getUsageSummary(organizationId, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [grouped, totalCalls] = await Promise.all([
    prisma.aiUsageLog.groupBy({
      by: ['kind'],
      where: { organizationId, createdAt: { gte: since } },
      _count: true,
      _sum: { cost: true }
    }),
    prisma.aiUsageLog.count({ where: { organizationId, createdAt: { gte: since } } })
  ]);

  const byKind = grouped
    .map((g) => ({
      kind: g.kind,
      label: KIND_LABEL[g.kind] || g.kind,
      calls: g._count,
      cost: g._sum.cost === null ? null : Number(g._sum.cost)
    }))
    .sort((a, b) => b.calls - a.calls);

  return { days, totalCalls, byKind };
}

module.exports = { KINDS, recordAiUsage, getUsageSummary };
