// Node >=20, playwright supplied via NODE_PATH. Uses its own isolated static server.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dist = path.resolve(__dirname, '../../apps/web/dist');
let revision = 1;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/') || pathname.startsWith('/socket.io/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Isolated test"}'); return;
  }
  let file = path.join(dist, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file)) file = path.join(dist, 'index.html');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  const content = fs.readFileSync(file);
  res.end(pathname === '/sw.js' ? Buffer.concat([Buffer.from(`// Test revision ${revision}\n`), content]) : content);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'niro-pwa-'));
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.PWA_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await context.newPage();
    await page.goto(base + '/offline.html');
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
    await page.reload();
    assert(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
    const manifest = await (await context.request.get(base + '/manifest.webmanifest')).json();
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) {
      const response = await context.request.get(base + icon.src); assert(response.ok()); assert.equal(response.headers()['content-type'], 'image/png');
      const bytes = await response.body(); const size = Number(icon.sizes.split('x')[0]);
      assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
    }
    await page.evaluate(async () => { await fetch('/api/org/conversations'); await fetch('/uploads/private.jpg'); });
    const caches = await page.evaluate(async () => Promise.all((await window.caches.keys()).map(async name => ({ name, urls: (await (await window.caches.open(name)).keys()).map(r => new URL(r.url).pathname) }))));
    assert(caches.every(c => c.urls.every(u => ['/offline.html', '/icons/niro-192.png'].includes(u))));
    await context.setOffline(true);
    await page.goto(base + '/inbox?conversation=offline-test');
    assert(await page.getByText('Volvemos cuando tengas conexión').isVisible());
    assert.equal(await page.evaluate(async () => { try { await fetch('/api/org/conversations'); return 'unexpected'; } catch { return 'network-only'; } }), 'network-only');
    await page.screenshot({ path: '/tmp/niro-offline.png' });
    await context.setOffline(false);
    revision++;
    await page.evaluate(async () => { window.previousController = navigator.serviceWorker.controller; await (await navigator.serviceWorker.getRegistration()).update(); });
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
    assert(await page.evaluate(() => navigator.serviceWorker.controller === window.previousController), 'Update must wait for user consent');
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await new Promise(resolve => { navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }); reg.waiting.postMessage({ type: 'NIRO_ACTIVATE_UPDATE' }); });
    });
    await page.goto(base + '/login');
    const cdp = await context.newCDPSession(page);
    const result = await cdp.send('Page.getAppManifest');
    assert.equal(result.errors.length, 0);
    const installability = await cdp.send('Page.getInstallabilityErrors');
    assert.equal(installability.installabilityErrors.length, 0, JSON.stringify(installability));
    console.log(JSON.stringify({ offline: true, privateRequestsNetworkOnly: true, updateWaitsForConsent: true, manifestErrors: result.errors, installability, caches }, null, 2));
  } finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exit(1); });
