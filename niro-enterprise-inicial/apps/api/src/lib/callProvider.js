const crypto = require('crypto');
const fs = require('fs');
const { EventEmitter } = require('events');
const path = require('path');
const { spawnSync } = require('child_process');
const whatsapp = require('./whatsapp');
const { resolveFfmpegCommand } = require('./ffmpeg');

// Voice calling is deliberately behind a provider boundary. Baileys itself only exposes
// signaling helpers; an outbound audio call needs the optional baileys-caller package and
// ffmpeg. Keeping that dependency optional lets the CRM run normally and makes the local
// campaign lifecycle testable without pretending a call reached a customer.

const clients = new Map();
const CALL_SOCKET_SETTLE_MS = Math.max(500, Number(process.env.WHATSAPP_CALL_SOCKET_SETTLE_MS || 1800));

function waitForSocketSettle() {
  return new Promise((resolve) => setTimeout(resolve, CALL_SOCKET_SETTLE_MS));
}

function configureFfmpegPath() {
  const configured = String(process.env.FFMPEG_PATH || '').trim();
  if (!configured) return;
  const directory = path.dirname(configured);
  const currentPath = String(process.env.PATH || '');
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  if (!entries.some((entry) => path.resolve(entry) === path.resolve(directory))) {
    process.env.PATH = [directory, ...entries].join(path.delimiter);
  }
}

function realDependencies() {
  configureFfmpegPath();
  let packageReady = true;
  try {
    require.resolve('baileys-caller');
  } catch {
    // baileys-caller is ESM-only and intentionally exposes only its import
    // condition, so require.resolve can reject a perfectly valid installation.
    packageReady = fs.existsSync(path.join(__dirname, '..', '..', 'node_modules', 'baileys-caller', 'dist', 'index.mjs'));
  }

  const ffmpeg = spawnSync(resolveFfmpegCommand(), ['-version'], {
    stdio: 'ignore',
    windowsHide: true
  });
  const ffmpegReady = !ffmpeg.error && ffmpeg.status === 0;
  return { packageReady, ffmpegReady };
}

function mode() {
  return String(process.env.WHATSAPP_CALL_PROVIDER || 'unavailable').toLowerCase();
}

function providerInfo() {
  const current = mode();
  if (current === 'mock') {
    return { mode: 'mock', available: true, label: 'Simulador local', production: false };
  }
  if (current !== 'baileys-caller') {
    return {
      mode: 'unavailable',
      available: false,
      label: 'Proveedor de llamadas no configurado',
      production: false,
      reason: 'Instalá baileys-caller, ffmpeg y configurá WHATSAPP_CALL_PROVIDER=baileys-caller para llamadas reales.'
    };
  }
  const dependencies = realDependencies();
  if (!dependencies.packageReady || !dependencies.ffmpegReady) {
    const missing = [
      !dependencies.packageReady ? 'baileys-caller' : null,
      !dependencies.ffmpegReady ? 'ffmpeg' : null
    ].filter(Boolean).join(' y ');
    return {
      mode: current,
      available: false,
      label: 'baileys-caller',
      production: true,
      dependencies,
      reason: `Falta ${missing}. Instalá las dependencias antes de iniciar una llamada real.`
    };
  }
  return { mode: current, available: true, label: 'baileys-caller', production: true, dependencies };
}

function normalizeProviderError(error) {
  if (error && typeof error.status === 'number') return error;
  const message = String(error?.message || error || 'Error desconocido del proveedor de llamadas');
  const providerStatus = Number(error?.output?.statusCode || error?.statusCode || 0);
  const connectionClosed = providerStatus === 428 || /connection\s+closed|socket\s+closed/i.test(message);
  const normalized = new Error(connectionClosed
    ? 'La sesión de WhatsApp perdió la conexión mientras se iniciaba la llamada. Esperá a que vuelva a conectarse y reintentá.'
    : `El proveedor de llamadas no pudo iniciar la llamada: ${message}`);
  normalized.status = connectionClosed ? 409 : 502;
  normalized.code = connectionClosed ? 'WHATSAPP_CONNECTION_CLOSED' : 'CALL_PROVIDER_ERROR';
  normalized.cause = error;
  return normalized;
}

function mockCall(phone, options = {}) {
  const events = new EventEmitter();
  const callId = `mock-${crypto.randomUUID()}`;
  const durationMs = Math.max(120, Number(options.durationMs || process.env.WHATSAPP_CALL_MOCK_DURATION_MS || 800));
  let ended = false;
  let timer;
  let resolveEnd;
  const endedPromise = new Promise((resolve) => { resolveEnd = resolve; });

  const finish = (reason) => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    events.emit('ended', reason);
    resolveEnd(reason);
  };

  const call = {
    callId,
    phone,
    on: (...args) => { events.on(...args); return call; },
    end: (reason = 'hangup') => finish(reason),
    pushAudio: (pcm) => events.emit('audio', pcm),
    off: (...args) => { events.off(...args); return call; },
    mute: () => {},
    waitForEnd: () => endedPromise
  };

  setTimeout(() => {
    if (ended) return;
    events.emit('ringing');
    setTimeout(() => {
      if (ended) return;
      events.emit('connected');
      events.emit('audio-started');
      timer = setTimeout(() => finish(options.audioSource === 'live' ? 'duration_limit' : 'audio_complete'), durationMs);
    }, 40);
  }, 20);

  return Promise.resolve(call);
}

async function loadVoipClient() {
  try {
    const module = await import('baileys-caller');
    return module.VoipClient || (module.default && module.default.VoipClient) || module.default;
  } catch (err) {
    const wrapped = new Error('baileys-caller no está instalado o no pudo cargarse');
    wrapped.code = 'CALL_PROVIDER_NOT_INSTALLED';
    wrapped.cause = err;
    throw wrapped;
  }
}

async function getClient(account) {
  const key = account.id;
  if (clients.has(key)) return clients.get(key);
  const VoipClient = await loadVoipClient();
  const client = new VoipClient({ authDir: account.sessionReference });
  clients.set(key, client);
  let timer;
  try {
    await Promise.race([client.connect(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tiempo agotado al conectar el proveedor de llamadas')), 30000);
    })]);
  } catch (error) {
    await closeAccount(key);
    throw error;
  } finally { clearTimeout(timer); }
  return client;
}

async function startCall(account, phone, options = {}) {
  const info = providerInfo();
  if (!info.available) {
    const error = new Error(info.reason);
    error.code = 'CALL_PROVIDER_UNAVAILABLE';
    throw error;
  }
  if (info.mode === 'mock') return mockCall(phone, options);

  const organizationId = options.organizationId;
  const pausedChatSocket = organizationId ? await whatsapp.pauseForCall(organizationId) : false;

  const restoreChatSocket = async () => {
    await closeAccount(account.id);
    if (pausedChatSocket) {
      try {
        await whatsapp.resumeAfterCall(organizationId);
        console.log(`[calls] WhatsApp reanudado después de la llamada para ${organizationId}`);
      } catch (resumeError) {
        console.error('[calls] no se pudo reanudar WhatsApp después de la llamada:', resumeError.message || resumeError);
      }
    }
  };

  try {
    const client = await getClient(account);
    const call = await client.call(phone, {
      audioSource: options.audioSource,
      durationMs: 0
    });

    let answerTimer;
    let durationTimer;
    let connected = false;
    const onConnected = () => {
      if (connected) return;
      connected = true;
      clearTimeout(answerTimer);
      durationTimer = setTimeout(() => call.end('duration_limit'), Math.max(1000, options.durationMs || 30 * 60 * 1000));
    };
    call.on('connected', onConnected);
    call.on('provider-error', error => console.warn('[calls] audio:', error.message));
    answerTimer = setTimeout(() => call.end('timeout'), Math.max(1000, options.answerTimeoutMs || 45000));
    if (Number(call.state) === 6) onConnected();
    const finished = call.waitForEnd().finally(async () => {
      clearTimeout(answerTimer);
      clearTimeout(durationTimer);
      await restoreChatSocket();
    });
    call.waitForEnd = () => finished;
    // Consumers wait for transport cleanup too, before releasing account locks.
    finished.catch(error => console.warn('[calls] cierre:', error.message));
    return call;
  } catch (error) {
    await restoreChatSocket();
    throw normalizeProviderError(error);
  }
}

async function closeAccount(accountId) {
  const client = clients.get(accountId);
  if (!client) return;
  clients.delete(accountId);
  try {
    const result = client.disconnect();
    if (result && typeof result.then === 'function') await result;
  } catch (error) {
    console.warn('[calls] cierre del cliente de voz omitido:', error.message || error);
  }
  // baileys-caller currently exposes a synchronous disconnect() API, but its
  // underlying Baileys websocket closes asynchronously. Do not reopen the
  // chat socket until WhatsApp has had time to release the shared credentials.
  await waitForSocketSettle();
}

async function shutdown() {
  await Promise.all([...clients.keys()].map((id) => closeAccount(id)));
}

module.exports = { providerInfo, startCall, closeAccount, shutdown };
