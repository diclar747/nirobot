// Niro bounded PCM feeder. Upstream attribution: LICENSE.baileys-caller.
import { spawn } from 'node:child_process';
export class AudioFeeder {
  constructor(sampleRate, channels, framesPerChunk, onChunk, source = 'silence', events = {}) {
    Object.assign(this, { sampleRate, channels, framesPerChunk, onChunk, source, events });
    this.pending = Buffer.alloc(0);
    this.running = false;
    this.eof = false;
    this.started = false;
    this.stats = { sent: 0, silent: 0, startedAt: 0 };
  }
  pushAudio(pcm) {
    if (!this.running || this.source !== 'live' || !(pcm instanceof Float32Array)) return;
    // Network format is 16 kHz mono. Adapt to the negotiated capture format.
    const frames = Math.round(pcm.length * this.sampleRate / 16000);
    const out = Buffer.alloc(frames * this.channels * 4);
    for (let i = 0; i < frames; i++) {
      const position = i * 16000 / this.sampleRate;
      const left = Math.min(pcm.length - 1, Math.floor(position));
      const value = pcm[left] + (pcm[Math.min(left + 1, pcm.length - 1)] - pcm[left]) * (position - left);
      for (let c = 0; c < this.channels; c++) out.writeFloatLE(Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0, (i * this.channels + c) * 4);
    }
    this.pending = Buffer.concat([this.pending, out]);
    // Drop old live audio instead of accumulating latency beyond 250 ms.
    const max = Math.floor(this.sampleRate / 4) * this.channels * 4;
    if (this.pending.length > max) this.pending = this.pending.subarray(this.pending.length - max);
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.stats.startedAt = Date.now();
    if (!['live', 'silence'].includes(this.source)) {
      this.proc = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', this.source, '-f', 'f32le', '-ac', String(this.channels), '-ar', String(this.sampleRate), 'pipe:1']);
      this.proc.stdout.on('data', (data) => {
        this.pending = Buffer.concat([this.pending, data]);
        if (this.pending.length > this.sampleRate * this.channels * 4 * 2) this.proc?.stdout.pause();
      });
      let detail = '';
      this.proc.stderr.on('data', data => { detail = (detail + data.toString()).slice(-500); });
      this.proc.on('error', error => this.fail(error));
      this.proc.on('close', code => {
        if (!this.running) return;
        if (code !== 0) this.fail(new Error(`No se pudo decodificar el audio (${code}): ${detail}`));
        else this.eof = true;
      });
    }
    // Real-time pacing: the timer only wakes us up; how many chunks go out is decided by the clock,
    // so a busy event loop delays audio slightly instead of slowing it down (which sounds like silence/garble).
    this.chunkMs = this.framesPerChunk / this.sampleRate * 1000;
    this.nextAt = Date.now();
    this.timer = setInterval(() => this.pump(), Math.max(5, Math.floor(this.chunkMs / 2)));
  }
  fail(error) { this.stop(); this.events.onError?.(error); }
  pump() {
    if (!this.running) return;
    if (this.events.canPlay && !this.events.canPlay()) { this.nextAt = Date.now(); return; }
    const now = Date.now();
    // Catch up after a stall, but never more than 10 chunks (200 ms) at once.
    if (now - this.nextAt > this.chunkMs * 10) this.nextAt = now - this.chunkMs * 10;
    while (this.running && this.nextAt <= now) {
      this.nextAt += this.chunkMs;
      this.tick();
    }
  }
  tick() {
    if (this.events.canPlay && !this.events.canPlay()) return;
    const bytes = this.framesPerChunk * this.channels * 4;
    if (this.eof && this.pending.length === 0) {
      const played = this.started;
      this.stop();
      if (played) this.events.onEnd?.();
      else this.events.onError?.(new Error('El archivo no contiene audio reproducible'));
      return;
    }
    const available = Math.min(bytes, this.pending.length);
    const pcm = new Float32Array(this.framesPerChunk * this.channels);
    for (let i = 0; i + 4 <= available; i += 4) pcm[i / 4] = this.pending.readFloatLE(i);
    this.pending = this.pending.subarray(available);
    if (this.proc?.stdout.isPaused() && this.pending.length < this.sampleRate * this.channels * 4) this.proc.stdout.resume();
    if (available) this.stats.sent += 1; else if (this.started) this.stats.silent += 1;
    this.onChunk(pcm);
    if (available && !this.started) { this.started = true; this.events.onStarted?.(); }
  }
  stop() {
    if (this.running && this.stats.startedAt) {
      const secs = Math.round((Date.now() - this.stats.startedAt) / 1000);
      console.log(`[calls] audio detenido a los ${secs}s: chunks con audio=${this.stats.sent} (~${Math.round(this.stats.sent * this.chunkMs / 1000)}s) huecos=${this.stats.silent} eof=${this.eof}`);
    }
    this.running = false;
    clearInterval(this.timer);
    this.proc?.kill('SIGTERM');
    this.proc = null;
    this.pending = Buffer.alloc(0);
  }
}
