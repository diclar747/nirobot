const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');

afterAll(async () => { await resetDb(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

function makeAudio(seconds, ext = 'mp3') {
  const file = path.join(os.tmpdir(), `audio-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libmp3lame', file]);
  const buffer = fs.readFileSync(file);
  fs.rmSync(file);
  return buffer;
}

async function setup() {
  const org = await createOrganization(prisma, { slug: 'call-audio-dur' });
  const owner = await createUser(prisma, { organizationId: org.id, email: 'owner@audiodur.test', role: 'OWNER' });
  const { agent, csrfToken } = await loginAgent(app, owner.email);
  return { org, agent, csrfToken };
}

describe('Audio de llamadas: máximo 60 segundos', () => {
  test('un audio corto se acepta', async () => {
    const { agent, csrfToken } = await setup();
    const res = await agent.post('/api/org/wa-calls/audios').set('X-CSRF-Token', csrfToken)
      .field('name', 'Promo corta')
      .attach('file', makeAudio(3), { filename: 'promo.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
    expect(res.body.audio.name).toBe('Promo corta');
  });

  test('un audio de más de 60 segundos se rechaza con un mensaje claro', async () => {
    const { agent, csrfToken } = await setup();
    const res = await agent.post('/api/org/wa-calls/audios').set('X-CSRF-Token', csrfToken)
      .field('name', 'Muy largo')
      .attach('file', makeAudio(75), { filename: 'largo.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/máximo.*60 s|60 segundos/i);
    expect(await prisma.callAudio.count()).toBe(0);
  });

  test('un audio de exactamente 60 segundos entra (con el margen técnico)', async () => {
    const { agent, csrfToken } = await setup();
    const res = await agent.post('/api/org/wa-calls/audios').set('X-CSRF-Token', csrfToken)
      .field('name', 'Justo al límite')
      .attach('file', makeAudio(60), { filename: 'limite.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(201);
  });
}, 30000);
