const { isIP } = require('node:net');
const proxyaddr = require('proxy-addr');
// Official Cloudflare ranges, verified 2026-09-19: cloudflare.com/ips-v4 and /ips-v6.
const isCloudflare = proxyaddr.compile([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32',
  '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32'
]);
function clientIp(req, _res, next) {
  // req.ip is already derived from Express' trusted proxy chain. Accept CF's
  // client header only when the first untrusted hop is actually Cloudflare.
  const client = req.get('cf-connecting-ip');
  if (process.env.TRUST_CLOUDFLARE === 'true' && isIP(client || '') && isIP(req.ip || '') && isCloudflare(req.ip)) {
    Object.defineProperty(req, 'ip', { value: client, configurable: true });
  }
  next();
}
module.exports = { clientIp };
