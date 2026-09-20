const { spawn } = require('child_process');
const path = require('path');
const { resolveFfmpegCommand } = require('./ffmpeg');

const DIRECT_TYPES = { 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg', 'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav' };
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.webm', '.amr', '.flac', '.wma', '.mp4']);

function isAcceptableAudio(file) {
  const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('audio/')) return true;
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext) && (!mime || mime === 'application/octet-stream' || mime === 'video/mp4' || mime === 'video/webm');
}

function transcodeToMp3(buffer) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegCommand(), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1'], { windowsHide: true });
    const out = [];
    const err = [];
    let done = false;
    const finish = (fn, value) => { if (!done) { done = true; fn(value); } };
    const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(reject, new Error('La conversión del audio tardó demasiado')); }, 60000);
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', (e) => { clearTimeout(timer); finish(reject, new Error(`No se pudo convertir el audio (FFmpeg no disponible): ${e.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || out.length === 0) return finish(reject, new Error(`No se pudo convertir el audio${err.length ? `: ${Buffer.concat(err).toString().slice(0, 200)}` : ''}`));
      finish(resolve, Buffer.concat(out));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(buffer);
  });
}

// Devuelve { buffer, mimeType, converted }: MP3/WAV pasan tal cual; el resto (m4a, ogg, opus, aac, amr…) se pasa a MP3.
async function normalizeCallAudio(file) {
  const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (DIRECT_TYPES[mime]) return { buffer: file.buffer, mimeType: DIRECT_TYPES[mime], converted: false };
  return { buffer: await transcodeToMp3(file.buffer), mimeType: 'audio/mpeg', converted: true };
}

module.exports = { isAcceptableAudio, normalizeCallAudio };
