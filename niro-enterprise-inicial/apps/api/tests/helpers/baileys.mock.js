function unsupported() {
  throw new Error('Baileys no está disponible durante las pruebas unitarias');
}

module.exports = {
  makeWASocket: unsupported,
  useMultiFileAuthState: unsupported,
  fetchLatestBaileysVersion: unsupported,
  DisconnectReason: { loggedOut: 401 },
  isJidGroup: () => false,
  isJidNewsletter: () => false,
  isJidBroadcast: () => false,
  isJidStatusBroadcast: () => false,
  isJidBot: () => false,
  isPnUser: (jid) => String(jid || '').endsWith('@s.whatsapp.net'),
  isLidUser: (jid) => String(jid || '').endsWith('@lid'),
  isHostedPnUser: (jid) => String(jid || '').endsWith('@hosted'),
  isHostedLidUser: (jid) => String(jid || '').endsWith('@hosted.lid'),
  downloadMediaMessage: unsupported
};
