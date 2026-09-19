const fs = require('fs');

function resolveFfmpegCommand() {
  const configured = String(process.env.FFMPEG_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return configured;

  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // The system executable remains the fallback for Docker and production hosts.
  }

  return 'ffmpeg';
}

module.exports = { resolveFfmpegCommand };
