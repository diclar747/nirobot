const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const FLOW_ROOT = process.env.WHATSAPP_QR_FLOW_ROOT
  || path.join(__dirname, '..', '..', 'storage', 'whatsapp-qr-flows');
const QR_BROWSER = ['Niro', 'Niro Web', '1.0.0'];
const flows = new Map();

function flowDir(flowId) {
  return path.join(FLOW_ROOT, flowId);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveSessionWithRetry(sourceDir, targetDir) {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
      }
      fs.renameSync(sourceDir, targetDir);
      return;
    } catch (err) {
      lastError = err;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt === 9) throw err;
      // Windows may release Baileys' final auth-file handle shortly after the
      // socket is ended. Retrying the directory move avoids a false HTTP 500.
      await wait(250 + attempt * 100);
    }
  }
  throw lastError;
}

function phoneFromJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || null;
}

function disconnectDetails(error) {
  return {
    statusCode: error?.output?.statusCode || error?.statusCode || null,
    name: error?.name || null,
    message: error?.message || 'sin detalle'
  };
}

function shouldRefreshQr(details) {
  return details.statusCode === 408
    || details.statusCode === 440
    || details.statusCode === 515
    || /QR refs attempts ended|restart required|conflict/i.test(details.message);
}

function scheduleQrRefresh(flowId, entry, details) {
  if (entry.refreshTimer || entry.finished) return;
  entry.status = 'connecting';
  entry.qr = null;
  entry.lastError = null;
  entry.refreshTimer = setTimeout(async () => {
    entry.refreshTimer = null;
    if (entry.finished || flows.get(flowId) !== entry) return;
    try {
      // 408/440 are expired or conflicting QR handshakes. Start them with a
      // clean temporary state; 515 can reuse state from a partial pairing.
      if (details.statusCode !== 515) fs.rmSync(flowDir(flowId), { recursive: true, force: true });
      flows.delete(flowId);
      await start(flowId);
      console.log(`[whatsapp-qr] QR renovado ${flowId}; causa=${details.statusCode || details.message}`);
    } catch (err) {
      const current = flows.get(flowId);
      if (current && !current.finished) {
        current.status = 'disconnected';
        current.lastError = err.message || 'No se pudo renovar el código QR';
      }
      console.warn(`[whatsapp-qr] no se pudo renovar el QR ${flowId}: ${err.message || err}`);
    }
  }, 700);
  entry.refreshTimer.unref?.();
}

async function resolveBaileysVersion() {
  const timeoutMs = Math.max(1000, Number(process.env.WHATSAPP_VERSION_TIMEOUT_MS || 8000));
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const latest = fetchLatestBaileysVersion()
      .then((result) => (result && result.version ? result : null))
      .catch((err) => {
        console.warn('[whatsapp-qr] no se pudo consultar la versión de Baileys:', err.message || err);
        return null;
      });
    return await Promise.race([latest, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function publicStatus(flowId) {
  const entry = flows.get(flowId);
  if (!entry) return { status: 'disconnected', qr: null, phone: null, lastError: null };
  return {
    status: entry.status,
    qr: entry.qr,
    phone: entry.phone,
    lastError: entry.lastError || null
  };
}

async function start(flowId) {
  const current = flows.get(flowId);
  if (current) return publicStatus(flowId);

  fs.mkdirSync(flowDir(flowId), { recursive: true });
  const authState = await useMultiFileAuthState(flowDir(flowId));
  const versionInfo = await resolveBaileysVersion();
  const entry = {
    sock: null,
    status: 'connecting',
    qr: null,
    phone: null,
    lastError: null,
    finished: false
  };
  flows.set(flowId, entry);

  const socketOptions = {
    auth: authState.state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: QR_BROWSER,
    syncFullHistory: false
  };
  if (versionInfo && versionInfo.version) socketOptions.version = versionInfo.version;

  const sock = makeWASocket(socketOptions);
  entry.sock = sock;
  console.log(`[whatsapp-qr] flujo iniciado ${flowId}`);
  sock.ev.on('creds.update', async (creds) => {
    // logout()/end() puede emitir un último creds.update de forma asíncrona.
    // No escribir después de finalizar el flujo evita ENOENT si la carpeta
    // temporal ya fue eliminada.
    if (entry.finished) return;
    try {
      await authState.saveCreds(creds);
    } catch (err) {
      if (!entry.finished) console.warn(`[whatsapp-qr] no se pudieron guardar credenciales ${flowId}: ${err.message || err}`);
    }
  });
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (entry.finished) return;
    if (qr) {
      try {
        entry.qr = await QRCode.toDataURL(qr, { margin: 1, width: 360 });
        entry.status = 'qr';
        entry.lastError = null;
        console.log(`[whatsapp-qr] QR listo ${flowId}`);
      } catch (err) {
        entry.status = 'disconnected';
        entry.lastError = err.message || 'No se pudo preparar el código QR';
        console.warn(`[whatsapp-qr] no se pudo convertir el QR ${flowId}: ${entry.lastError}`);
      }
    }
    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.lastError = null;
      entry.phone = phoneFromJid(sock.user && sock.user.id);
      console.log(`[whatsapp-qr] flujo conectado ${flowId}`);
    }
    if (connection === 'close') {
      entry.sock = null;
      entry.qr = null;
      if (!entry.finished) {
        const details = disconnectDetails(lastDisconnect?.error);
        console.warn(`[whatsapp-qr] flujo cerrado ${flowId}; código=${details.statusCode || 'desconocido'}; tipo=${details.name || 'desconocido'}; detalle=${details.message}`);
        if (shouldRefreshQr(details)) {
          scheduleQrRefresh(flowId, entry, details);
        } else {
          entry.status = 'disconnected';
          entry.lastError = details.message || 'La conexión QR se cerró';
        }
      }
    }
  });

  return publicStatus(flowId);
}

async function closeSocket(entry, logout) {
  if (!entry || !entry.sock) return;
  if (entry.refreshTimer) {
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = null;
  }
  try {
    if (logout && entry.status === 'connected' && typeof entry.sock.logout === 'function') {
      await entry.sock.logout();
    } else if (typeof entry.sock.end === 'function') {
      entry.sock.end(undefined);
    }
  } catch (err) {
    console.warn('[whatsapp-qr] cierre de flujo omitido:', err.message || err);
  }
  entry.sock = null;
}

async function cancel(flowId) {
  const entry = flows.get(flowId);
  if (entry) {
    entry.finished = true;
    await closeSocket(entry, true);
  }
  flows.delete(flowId);
  try {
    // En Windows Baileys puede terminar de guardar creds.json unos milisegundos
    // después de logout(). La limpieza es secundaria al login y nunca debe
    // convertir una autenticación correcta en un HTTP 500.
    fs.rmSync(flowDir(flowId), {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150
    });
  } catch (err) {
    console.warn(`[whatsapp-qr] limpieza diferida ${flowId}: ${err.code || err.message || err}`);
    const timer = setTimeout(() => {
      try {
        fs.rmSync(flowDir(flowId), { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
      } catch (retryErr) {
        console.warn(`[whatsapp-qr] no se pudo limpiar el flujo ${flowId}: ${retryErr.code || retryErr.message || retryErr}`);
      }
    }, 1500);
    timer.unref?.();
  }
}

async function takeSession(flowId, targetDir) {
  const entry = flows.get(flowId);
  if (!entry) throw new Error('El flujo QR no existe');
  if (entry.status !== 'connected' || !entry.phone) throw new Error('El QR todavía no fue escaneado');

  entry.finished = true;
  await closeSocket(entry, false);
  const sourceDir = flowDir(flowId);
  await moveSessionWithRetry(sourceDir, targetDir);
  flows.delete(flowId);
  return { phone: entry.phone, sessionReference: targetDir };
}

async function shutdown() {
  const ids = [...flows.keys()];
  await Promise.all(ids.map((flowId) => cancel(flowId)));
}

module.exports = { start, getStatus: publicStatus, cancel, takeSession, shutdown };
