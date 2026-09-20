const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, prisma, resetDb } = require('./helpers/testApp');
const { createOrganization, createUser, loginAgent } = require('./helpers/auth');
const whatsapp = require('../src/lib/whatsapp');
const posts = require('../src/lib/statusPosts');

let send;
beforeEach(async () => {
  await resetDb();
  jest.spyOn(whatsapp, 'getStatus').mockImplementation(() => ({ status: 'connected' }));
  send = jest.spyOn(whatsapp, 'sendStatusBroadcast').mockResolvedValue('WA-VIDEO-1');
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

function makeVideo(seconds, ext = 'mp4') {
  const file = path.join(os.tmpdir(), `t-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const buffer = fs.readFileSync(file);
  fs.rmSync(file);
  return buffer;
}

async function setup() {
  const org = await createOrganization(prisma, { slug: 'video-co' });
  const user = await createUser(prisma, { organizationId: org.id, email: 'v@video.test', role: 'ADMIN' });
  await prisma.contact.create({ data: { organizationId: org.id, name: 'Ana', phone: '595981000001' } });
  return loginAgent(app, user.email);
}

const create = (s, buffer, type = 'video/mp4', fields = {}) => {
  const req = s.agent.post('/api/org/status-posts').set('X-CSRF-Token', s.csrfToken)
    .field('contentType', 'video').field('audienceType', 'ALL').field('mode', 'NOW').field('caption', 'Mira');
  Object.entries(fields).forEach(([k, v]) => req.field(k, v));
  return req.attach('file', buffer, { filename: 'clip.mp4', contentType: type });
};

async function waitPublished(id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const row = await prisma.whatsappStatusPost.findUnique({ where: { id } });
    if (row.status === 'published') return row;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no se publicó');
}

describe('estados con video', () => {
  jest.setTimeout(60000);

  test('publica un video de 5 s reencodeado a MP4 con caption', async () => {
    const s = await setup();
    const res = await create(s, makeVideo(5));
    expect(res.status).toBe(201);
    expect(res.body.post).toMatchObject({ contentType: 'video', mediaUrl: expect.stringContaining('/media') });
    await waitPublished(res.body.post.id);
    const content = send.mock.calls[0][1];
    expect(Buffer.isBuffer(content.video)).toBe(true);
    expect(content).toMatchObject({ mimetype: 'video/mp4', caption: 'Mira' });
    const media = await s.agent.get(res.body.post.mediaUrl).expect(200);
    expect(media.headers['content-type']).toMatch(/video\/mp4/);
  });

  test('rechaza un video de más de 60 s sin guardar nada', async () => {
    const s = await setup();
    const res = await create(s, makeVideo(75));
    expect(res.status).toBe(400);
    expect(res.body.error || res.body.message).toMatch(/60 s/);
    expect(await prisma.whatsappStatusPost.count()).toBe(0);
  });

  test('rechaza un archivo que no es video y tipos no permitidos', async () => {
    const s = await setup();
    expect((await create(s, Buffer.from('no soy un video'))).status).toBe(400);
    expect((await create(s, Buffer.from('x'), 'application/pdf')).status).toBe(400);
    expect(await prisma.whatsappStatusPost.count()).toBe(0);
  });

  test('un video dentro de una campaña se programa y se publica como video', async () => {
    const s = await setup();
    const res = await s.agent.post('/api/org/status-campaigns').set('X-CSRF-Token', s.csrfToken)
      .field('name', 'Clips').field('intervalHours', '4').field('startAt', new Date(Date.now() + 3600 * 1000).toISOString())
      .field('audienceType', 'ALL').field('replacePrevious', 'false')
      .field('items', JSON.stringify([{ contentType: 'video', caption: 'Uno', fileIndex: 0 }, { contentType: 'text', textContent: 'Dos' }]))
      .attach('files', makeVideo(3), { filename: 'a.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(201);
    const items = await prisma.whatsappStatusPost.findMany({ where: { campaignId: res.body.campaign.id }, orderBy: { sequence: 'asc' } });
    expect(items[0]).toMatchObject({ contentType: 'video', mimeType: 'video/mp4' });
    await prisma.whatsappStatusPost.update({ where: { id: items[0].id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await posts.runDue();
    expect(send.mock.calls[0][1]).toHaveProperty('video');
  });
});
