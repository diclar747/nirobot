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

module.exports = { transcribeMessageAudio, extractMessageImage };
