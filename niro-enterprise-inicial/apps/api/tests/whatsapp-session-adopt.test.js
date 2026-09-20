const fs = require('fs');
const os = require('os');
const path = require('path');

describe('reemplazo de sesión de WhatsApp por un QR nuevo', () => {
  let root;
  let whatsapp;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-adopt-'));
    process.env.WHATSAPP_SESSION_ROOT = path.join(root, 'whatsapp-sessions');
    jest.isolateModules(() => { whatsapp = require('../src/lib/whatsapp'); });
  });
  afterEach(() => { delete process.env.WHATSAPP_SESSION_ROOT; fs.rmSync(root, { recursive: true, force: true }); });

  test('archiva las credenciales muertas fuera de SESSION_ROOT y entrega el directorio limpio', async () => {
    const dir = whatsapp.getSessionReference('org1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ me: { id: '595994854167:1@s.whatsapp.net' }, registered: true }));

    const taken = await whatsapp.adoptSession('org1', async (target) => {
      expect(target).toBe(dir);
      expect(fs.existsSync(target)).toBe(false); // el reemplazo no ve las credenciales viejas
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'creds.json'), '{"fresh":true}');
      return { phone: '595994854167' };
    });

    expect(taken).toEqual({ phone: '595994854167' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'))).toEqual({ fresh: true });
    const archived = fs.readdirSync(path.join(process.env.WHATSAPP_SESSION_ROOT, '.removed'));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^org1-replaced-/);
    // Nada archivado dentro de SESSION_ROOT: un reinicio no puede reanudarlo como si fuera otra organización.
    expect(fs.readdirSync(process.env.WHATSAPP_SESSION_ROOT)).toEqual(['.removed', 'org1']);
  });

  test('sin sesión previa simplemente entrega el directorio', async () => {
    const result = await whatsapp.adoptSession('org2', async (target) => target);
    expect(result).toBe(whatsapp.getSessionReference('org2'));
  });
});
