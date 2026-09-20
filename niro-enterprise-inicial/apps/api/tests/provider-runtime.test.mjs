import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActiveCall, CallState } from 'baileys-caller';
import { AudioFeeder } from '../patches/audio-feeder.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const limit = (promise) => Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 3000); t.unref(); })]);
test('local hangup and synchronous remote callback preserve reason and settle once', async () => {
  let call;
  call = new ActiveCall('offline', { endCall() { call._updateState(CallState.Ending); } }, 0);
  let events = 0; call.on('ended', () => events++);
  call.end('audio_complete'); call.end();
  assert.equal(await limit(call.waitForEnd()), 'audio_complete'); assert.equal(events, 1);
});
test('automatic timeout settles', async () => {
  const call = new ActiveCall('offline', { endCall() {} }, 10);
  assert.equal(await limit(call.waitForEnd()), 'duration_limit');
});
test('remote close settles', async () => {
  const call = new ActiveCall('offline', {}, 0);
  call._updateState(CallState.Active); call._updateState(CallState.Ending);
  assert.equal(await limit(call.waitForEnd()), 'ended');
});
test('live PCM is forwarded and queue is bounded', () => {
  const frames = [];
  const feeder = new AudioFeeder(16000, 1, 320, pcm => frames.push(pcm), 'live');
  feeder.start();
  try {
    feeder.pushAudio(new Float32Array(320).fill(0.25)); feeder.tick();
    assert.equal(frames[0][5], 0.25);
    for (let i = 0; i < 100; i++) feeder.pushAudio(new Float32Array(320));
    assert.ok(feeder.pending.length <= 16000);
  } finally { feeder.stop(); }
});
test('file playback drains all frames before completing, and waits for answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'niro-audio-'));
  // 100 ms PCM WAV generated locally, no ffmpeg fixture/network dependency.
  const wav = Buffer.alloc(44 + 1600 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(3200, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(8192, i);
  const file = join(dir, 'sample.wav'); writeFileSync(file, wav);
  let answered = false; let samples = 0; let started = 0; let feeder;
  try {
    await limit(new Promise((resolve, reject) => {
      feeder = new AudioFeeder(16000, 1, 320, pcm => { samples += [...pcm].filter(x => x > 0).length; }, file,
        { canPlay: () => answered, onStarted: () => started++, onEnd: resolve, onError: reject });
      feeder.start(); setTimeout(() => { assert.equal(samples, 0); answered = true; }, 100);
    }));
    assert.equal(samples, 1600); assert.equal(started, 1);
  } finally { feeder?.stop(); rmSync(dir, { recursive: true, force: true }); }
});
