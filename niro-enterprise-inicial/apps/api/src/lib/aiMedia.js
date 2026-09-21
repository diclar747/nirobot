// Helpers de IA sobre adjuntos: transcripción de audio y OCR/lectura de factura.
// Todo pasa por niroAi.js; acá solo se decide qué hacer con el resultado y nunca se deja que
// un fallo de IA rompa el flujo normal de mensajería (siempre se atrapa el error y se sigue).

const niroAi = require('./niroAi');
const { prisma } = require('./prisma');
const { KINDS, recordAiUsage } = require('./aiUsage');

/** Transcribe un audio entrante y lo guarda en Message.transcription. Nunca lanza. */
async function transcribeMessageAudio(organizationId, messageId, buffer, fileName, mimeType) {
  if (!niroAi.isConfigured()) return null;
  try {
    const { text, cost } = await niroAi.transcribeAudio(buffer, fileName, mimeType);
    await recordAiUsage(organizationId, KINDS.TRANSCRIPTION, cost);
    if (!text) return null;
    await prisma.message.update({ where: { id: messageId }, data: { transcription: text } });
    return text;
  } catch (err) {
    console.error('[ai-media] transcripción falló:', err.message || err);
    return null;
  }
}

/** OCR de una imagen/factura entrante. Igual que arriba: nunca lanza. */
async function extractMessageImage(organizationId, messageId, buffer, fileName, mimeType, mode) {
  if (!niroAi.isConfigured()) return null;
  try {
    const { text, data, cost } = await niroAi.visionExtract(buffer, fileName, mimeType, { mode });
    await recordAiUsage(organizationId, KINDS.VISION, cost);
    if (!text) return null;
    await prisma.message.update({ where: { id: messageId }, data: { transcription: text } });
    return { text, data };
  } catch (err) {
    console.error('[ai-media] OCR falló:', err.message || err);
    return null;
  }
}

/**
 * Si la organización activó "transcribir audios automáticamente", transcribe el audio recién llegado
 * y avisa en vivo al chat para que el texto aparezca debajo del audio. Nunca lanza.
 */
async function autoTranscribeIfEnabled({ organizationId, conversationId, messageId, buffer, fileName, mimeType }) {
  try {
    if (!buffer || !niroAi.isConfigured()) return null;
    const settings = await prisma.organizationSettings.findUnique({ where: { organizationId }, select: { autoTranscribeAudio: true } });
    if (!settings || !settings.autoTranscribeAudio) return null;
    if (await require('./billing').isBlocked(organizationId).catch(() => false)) return null; // plan vencido: no se gasta IA
    const text = await transcribeMessageAudio(organizationId, messageId, buffer, fileName, mimeType);
    if (!text) return null;
    const { MESSAGE_INCLUDE, sanitizeMessage } = require('./conversations');
    const full = await prisma.message.findUnique({ where: { id: messageId }, include: MESSAGE_INCLUDE });
    if (full) require('./realtime').emitToOrg(organizationId, 'message:updated', { conversationId, message: sanitizeMessage(full) });
    return text;
  } catch (err) {
    console.error('[ai-media] transcripción automática falló:', err.message || err);
    return null;
  }
}

module.exports = { transcribeMessageAudio, extractMessageImage, autoTranscribeIfEnabled };
