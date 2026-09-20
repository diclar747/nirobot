const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const { resolveFfmpegCommand } = require('../src/lib/ffmpeg');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

function makeAudio(ext) {
  const file = path.join(os.tmpdir(), `tone-${Date.now()}.${ext}`);
  const codec = { m4a: ['-c:a', 'aac'], ogg: ['-c:a', 'libvorbis'], mp3: ['-c:a', 'libmp3lame'] }[ext];
  const r = spawnSync(resolveFfmpegCommand(), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...codec, file]);
  if (r.status !== 0) throw new Error(`ffmpeg no generó el audio de prueba: ${String(r.stderr).slice(0, 200)}`);
  return file;
}

async function setup() {
  const org = await createOrganization(prisma, { slug: `aud-${Date.now()}` });
  const owner = await createUser(prisma, { organizationId: org.id, email: `o${Date.now()}@aud.test`, role: 'OWNER' });
  return loginAgent(app, owner.email);
}

describe('Subida de audio para llamadas', () => {
  test.each(['mp3', 'm4a', 'ogg'])('acepta .%s y lo guarda como MP3/WAV', async (ext) => {
    const { agent, csrfToken } = await setup();
    const res = await agent.post('/api/org/wa-calls/audios').set('X-CSRF-Token', csrfToken).field('name', `Audio ${ext}`).attach('file', makeAudio(ext));
    expect(res.status).toBe(201);
    expect(res.body.audio.mimeType).toMatch(/audio\/(mpeg|wav)/);
    expect(res.body.audio.size).toBeGreaterThan(500);
  });

  test('un archivo que no es audio da un 400 claro (no 500)', async () => {
    const { agent, csrfToken } = await setup();
    const res = await agent.post('/api/org/wa-calls/audios').set('X-CSRF-Token', csrfToken).attach('file', Buffer.from('hola'), { filename: 'nota.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Formato no soportado/);
  });
});
