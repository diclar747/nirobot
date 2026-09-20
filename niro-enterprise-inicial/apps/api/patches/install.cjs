// Reproducible fixes for pinned baileys-caller 36c6e0a; preserve upstream MIT license.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = path.join(__dirname, '../node_modules/baileys-caller/dist');
const target = path.join(dir, 'index.mjs');
const replacement = fs.readFileSync(path.join(__dirname, 'caller-index.mjs'));
const current = fs.readFileSync(target);
const hash = crypto.createHash('sha256').update(current).digest('hex');
if (hash !== '4aa112ee2bbe5f4abee2b5b9413f1608d22799042211c7ef12d332dd2faf2834' && !current.equals(replacement)) {
  throw new Error('Unexpected baileys-caller revision; review patches before updating');
}
fs.writeFileSync(target, replacement);
fs.copyFileSync(path.join(__dirname, 'audio-feeder.mjs'), path.join(dir, 'audio-feeder.mjs'));
console.log('Applied Niro call lifecycle and live audio fixes');
