// Media for WhatsApp statuses. Images are stored as uploaded; videos are validated (<= 60 s) and
// re-encoded to H.264/AAC MP4, the only format WhatsApp reliably plays as a status, and kept small
// (WhatsApp rejects status videos above ~16 MB).
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const multer = require('multer');
const { resolveFfmpegCommand } = require('./ffmpeg');
const { normalizeMimeType } = require('./attachments');
const { HttpError } = require('./errors');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp']);
const MAX_VIDEO_SECONDS = 60;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ENCODED_BYTES = 16 * 1024 * 1024;
const ENCODE_TIMEOUT_MS = 180 * 1000;

const rawUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 60 },
  fileFilter: (_req, file, cb) => {
    const type = normalizeMimeType(file.mimetype);
    if (IMAGE_TYPES.has(type) || VIDEO_TYPES.has(type)) return cb(null, true);
    cb(new HttpError(400, 'Solo se permiten imágenes (JPG, PNG, WebP) o videos (MP4, MOV, WebM)'));
  }
});

// Multer's generic "15 MB" message is wrong here: statuses accept up to 100 MB before re-encoding.
function wrapUpload(middleware) {
  return (req, res, next) => middleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera el máximo de ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` : 'No se pudo subir el archivo'));
    }
    next(err);
  });
}
const statusUpload = {
  single: (field) => wrapUpload(rawUpload.single(field)),
  array: (field, max) => wrapUpload(rawUpload.array(field, max))
};

function run(command, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `salió con código ${code}`));
    });
  });
}

// ffprobe is not always shipped next to a bundled ffmpeg, so read the stream info ffmpeg itself prints
// (it then exits non-zero because no output file was given; the report is what matters).
async function probe(file) {
  let report = '';
  try {
    await run(resolveFfmpegCommand(), ['-hide_banner', '-i', file], { timeoutMs: 20000 });
  } catch (err) {
    report = String(err.message || '');
  }
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(report);
  if (!duration && !/Stream #/.test(report)) throw new Error('no se pudo leer');
  return {
    hasVideo: /Stream #[^\n]*Video:/.test(report),
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null
  };
}

async function normalizeVideo(buffer) {
  const base = path.join(os.tmpdir(), `status-${crypto.randomBytes(8).toString('hex')}`);
  const input = `${base}.in`;
  const output = `${base}.mp4`;
  try {
    await fs.writeFile(input, buffer);
    let info;
    try {
      info = await probe(input);
    } catch {
      throw new HttpError(400, 'No se pudo leer el video. Probá con otro archivo MP4 o MOV.');
    }
    if (!info.hasVideo) throw new HttpError(400, 'El archivo no contiene video.');
    if (info.duration === null) throw new HttpError(400, 'No se pudo medir la duración del video.');
    if (info.duration > MAX_VIDEO_SECONDS + 0.5) {
      throw new HttpError(400, `El video dura ${Math.round(info.duration)} s; el máximo para un estado es ${MAX_VIDEO_SECONDS} s.`);
    }
    try {
      await run(resolveFfmpegCommand(), [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-t', String(MAX_VIDEO_SECONDS),
        '-vf', "scale='min(720,iw)':'-2',format=yuv420p",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-maxrate', '1800k', '-bufsize', '3600k',
        '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        '-movflags', '+faststart', output
      ], { timeoutMs: ENCODE_TIMEOUT_MS });
    } catch (err) {
      throw new HttpError(422, `No se pudo procesar el video (${String(err.message).slice(0, 120)}).`);
    }
    const encoded = await fs.readFile(output);
    if (encoded.length > MAX_ENCODED_BYTES) throw new HttpError(400, 'El video pesa demasiado incluso comprimido; usá uno más corto o de menor resolución.');
    return { buffer: encoded, mimeType: 'video/mp4', durationSeconds: Math.round(info.duration) };
  } finally {
    await Promise.all([fs.rm(input, { force: true }), fs.rm(output, { force: true })]);
  }
}

// Validates an uploaded file for the declared kind and returns what must be stored.
async function prepareStatusMedia(file, contentType) {
  const type = normalizeMimeType(file.mimetype);
  if (contentType === 'image') {
    if (!IMAGE_TYPES.has(type)) throw new HttpError(400, 'La imagen debe ser JPG, PNG o WebP');
    return { buffer: file.buffer, mimeType: type };
  }
  if (contentType === 'video') {
    if (!VIDEO_TYPES.has(type)) throw new HttpError(400, 'El video debe ser MP4, MOV o WebM');
    return normalizeVideo(file.buffer);
  }
  throw new HttpError(400, 'Tipo de contenido no válido');
}

module.exports = { statusUpload, prepareStatusMedia, MAX_VIDEO_SECONDS, MAX_UPLOAD_BYTES };
