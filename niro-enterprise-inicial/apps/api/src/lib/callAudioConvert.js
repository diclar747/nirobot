const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { resolveFfmpegCommand } = require('./ffmpeg');
const { HttpError } = require('./errors');

// Igual que un mensaje de voz de WhatsApp: la gente no escucha un audio de llamada de varios minutos.
const MAX_AUDIO_SECONDS = 60;

const DIRECT_TYPES = { 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg', 'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav' };
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.webm', '.amr', '.flac', '.wma', '.mp4']);

function isAcceptableAudio(file) {
  const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('audio/')) return true;
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext) && (!mime || mime === 'application/octet-stream' || mime === 'video/mp4' || mime === 'video/webm');
}

// ffprobe no siempre viene junto al ffmpeg incluido, así que se lee el reporte que el propio ffmpeg imprime por
// stderr (termina con código distinto de cero porque no se le da un archivo de salida; el reporte es lo que importa).
// Por archivo, no por pipe: un MP3/OGG leído por stdin no se puede "rebobinar" para calcular la duración exacta
// (ffmpeg contesta "Duration: N/A") — igual que el chequeo de video de los estados de WhatsApp.
function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegCommand(), ['-hide_banner', '-i', file], { windowsHide: true });
    let report = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('timeout')); }, 15000);
    proc.stderr.on('data', (chunk) => { report = (report + chunk).slice(-6000); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', () => {
      clearTimeout(timer);
      const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(report);
      if (!match || report.includes('Duration: N/A')) return reject(new Error('no se pudo leer'));
      resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
  });
}

async function assertDuration(buffer) {
  const file = path.join(os.tmpdir(), `call-audio-${crypto.randomBytes(8).toString('hex')}`);
  await fs.writeFile(file, buffer);
  try {
    let seconds;
    try {
      seconds = await probeDuration(file);
    } catch {
      throw new HttpError(400, 'No se pudo leer el audio. Probá con otro archivo.');
    }
    if (seconds > MAX_AUDIO_SECONDS + 0.5) {
      throw new HttpError(400, `El audio dura ${Math.round(seconds)} s; el máximo para una llamada es ${MAX_AUDIO_SECONDS} s (1 minuto).`);
    }
  } finally {
    await fs.unlink(file).catch(() => {});
  }
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
  await assertDuration(file.buffer);
  const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (DIRECT_TYPES[mime]) return { buffer: file.buffer, mimeType: DIRECT_TYPES[mime], converted: false };
  return { buffer: await transcodeToMp3(file.buffer), mimeType: 'audio/mpeg', converted: true };
}

module.exports = { isAcceptableAudio, normalizeCallAudio, assertAudioDuration: assertDuration, MAX_AUDIO_SECONDS };
