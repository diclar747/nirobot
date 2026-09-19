const { resolvePath } = require('./storage');

// Extension/allowlist is deliberately narrow: images, audio, video and common office/document
// formats. Anything executable or script-bearing (.exe, .js, .html, .svg — SVG can embed
// <script>) is rejected outright, both by extension AND by the reported MIME type.
const ALLOWED_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt'
};

const MAX_SIZE = 15 * 1024 * 1024;

function isAllowedMimeType(mimeType) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, normalizeMimeType(mimeType));
}

function extensionFor(mimeType) {
  return ALLOWED_TYPES[normalizeMimeType(mimeType)] || '';
}

function normalizeMimeType(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

function safeDownloadName(name) {
  const cleaned = (name || 'archivo').replace(/[^\w.\- ]/g, '_').trim();
  return cleaned.slice(0, 150) || 'archivo';
}

function sanitizeAttachment(attachment) {
  if (!attachment) return null;
  return { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size };
}

// Images, video and audio render inline in a chat bubble (an <img>/<video>/<audio> tag can't
// play a resource served as Content-Disposition: attachment); documents force a download
// instead of letting the browser try to display/execute an arbitrary uploaded file.
function sendAttachmentFile(res, attachment) {
  const filePath = resolvePath(attachment.storageKey);
  const isInlineable = /^(image|video|audio)\//.test(attachment.mimeType);
  const disposition = isInlineable ? 'inline' : 'attachment';
  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeDownloadName(attachment.fileName)}"`);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Archivo no encontrado' });
  });
}

module.exports = { ALLOWED_TYPES, MAX_SIZE, isAllowedMimeType, extensionFor, normalizeMimeType, safeDownloadName, sanitizeAttachment, sendAttachmentFile };
