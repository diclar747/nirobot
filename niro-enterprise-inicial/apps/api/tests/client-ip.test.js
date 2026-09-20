const { clientIp } = require('../src/middleware/clientIp');
afterEach(() => { delete process.env.TRUST_CLOUDFLARE; });
test('does not trust a spoofed Cloudflare header from a direct client', () => {
  process.env.TRUST_CLOUDFLARE = 'true';
  const req = { ip: '203.0.113.2', get: () => '198.51.100.99' };
  clientIp(req, {}, () => {}); expect(req.ip).toBe('203.0.113.2');
});
test('uses client IP only behind verified Cloudflare hop and explicit configuration', () => {
  const req = { ip: '172.64.1.1', get: () => '198.51.100.99' };
  clientIp(req, {}, () => {}); expect(req.ip).toBe('172.64.1.1');
  process.env.TRUST_CLOUDFLARE = 'true';
  clientIp(req, {}, () => {}); expect(req.ip).toBe('198.51.100.99');
});
