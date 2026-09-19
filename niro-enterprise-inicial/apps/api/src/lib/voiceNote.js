const { spawn } = require('child_process');
const { resolveFfmpegCommand } = require('./ffmpeg');

function shouldConvert(mimeType) {
  return !String(mimeType || '').toLowerCase().startsWith('audio/ogg');
}

function convertToWhatsAppVoiceNote(buffer, mimeType) {
  if (!shouldConvert(mimeType)) return Promise.resolve({ buffer, mimeType: 'audio/ogg' });

  return new Promise((resolve, reject) => {
    const process = spawn(resolveFfmpegCommand(), [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-ac', '1', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '32k',
      '-f', 'ogg', 'pipe:1'
    ], { windowsHide: true });
    const chunks = [];
    const errors = [];
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    process.stdout.on('data', (chunk) => chunks.push(chunk));
    process.stderr.on('data', (chunk) => errors.push(chunk));
    process.on('error', (error) => finish(reject, new Error(`No se pudo convertir la nota de voz. Instalá FFmpeg en el servidor. ${error.message}`)));
    process.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        finish(reject, new Error(`FFmpeg no pudo convertir la nota de voz${detail ? `: ${detail.slice(0, 240)}` : ''}`));
        return;
      }
      finish(resolve, { buffer: Buffer.concat(chunks), mimeType: 'audio/ogg' });
    });

    process.stdin.on('error', () => {});
    process.stdin.end(buffer);
  });
}

module.exports = { convertToWhatsAppVoiceNote, shouldConvert };
